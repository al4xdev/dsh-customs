package dev.alex.dsh.companion.protocol

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

data class AssistantLive(val attemptId: String, val turn: Long, val step: Long, val nextIndex: Long, val text: String, val extensions: List<JsonElement>, val unsupportedKinds: Set<String>, val textBlocks: Map<Long, String> = emptyMap())
data class AssistantState(val generation: Long, val revision: Long, val ready: Boolean, val live: AssistantLive?, val awaitingSettlementSeq: Long?)
sealed interface AssistantUpdate {
    data object Ignored : AssistantUpdate
    data object Changed : AssistantUpdate
    data object RebaselineRequired : AssistantUpdate
    data class Settled(val event: SessionEvent) : AssistantUpdate
    data class Abandoned(val attemptId: String) : AssistantUpdate
}

/** Text-first presentation only. Extensions remain JSON, never executable tool actions. */
class AssistantAssembler(initialGeneration: Long = 0) {
    private data class End(val eventType: String, val seq: Long)
    private class Attempt(val id: String, val startedAfterSeq: Long, val turn: Long, val step: Long) {
        var nextIndex = 0L
        val text = linkedMapOf<Long, StringBuilder>()
        val extensions = mutableListOf<JsonElement>()
        val unsupported = mutableSetOf<String>()
        var extensionSize = 0
        var end: End? = null
        // Rich presentation needs the original block indices to interleave text,
        // reasoning and tools. Keep the legacy flattened text for existing callers.
        fun snapshot(): AssistantLive {
            val blocks = text.mapValues { it.value.toString() }
            return AssistantLive(id, turn, step, nextIndex, blocks.values.joinToString(""), extensions.toList(), unsupported.toSet(), blocks)
        }
    }
    private var generation = initialGeneration.also { if (it < 0) reject("invalid-generation") }
    private var revision = 0L
    private var ready = false
    private var active: Attempt? = null
    private val pendingDurable = linkedMapOf<Long, SessionEvent>()

    @Synchronized fun state(): AssistantState = AssistantState(generation, revision, ready, active?.snapshot(), active?.end?.seq)
    @Synchronized fun beginGeneration(value: Long) {
        if (value <= generation) reject("generation-not-increasing")
        generation = value; ready = false; active = null; revision = 0; pendingDurable.clear()
    }
    @Synchronized fun baseline(value: JsonObject, deliveredGeneration: Long, durableCursor: Long): AssistantUpdate {
        if (deliveredGeneration != generation) return AssistantUpdate.Ignored
        WireJson.validate(value)
        value.keysExactly(setOf("revision"), setOf("activeAttempt"))
        val newRevision = value.required("revision").safeInteger()
        val attempt = value["activeAttempt"]?.objectValue()?.let { raw ->
            raw.keysExactly(setOf("attemptId", "startedAfterSeq", "turn", "step", "nextIndex", "stream"))
            val candidate = attempt(raw)
            if (candidate.startedAfterSeq > durableCursor) reject("attempt-past-cursor")
            raw.required("stream").arrayValue().forEach { expand(candidate, it.objectValue()) }
            if (candidate.nextIndex != raw.required("nextIndex").safeInteger()) reject("baseline-index-mismatch")
            candidate
        }
        revision = newRevision; active = attempt; ready = true; pendingDurable.clear()
        return AssistantUpdate.Changed
    }

    @Synchronized fun frame(value: JsonObject, deliveredGeneration: Long): AssistantUpdate {
        if (deliveredGeneration != generation) return AssistantUpdate.Ignored
        if (!ready) return AssistantUpdate.RebaselineRequired
        WireJson.validate(value)
        val nextRevision = value.required("revision").safeInteger()
        if (nextRevision != revision + 1) {
            ready = false; active = null; pendingDurable.clear()
            return AssistantUpdate.RebaselineRequired
        }
        val id = opaqueId(value.required("attemptId").stringValue(160))
        when (value.required("type").stringValue()) {
            "start" -> {
                value.keysExactly(setOf("type", "attemptId", "revision", "startedAfterSeq", "turn", "step"))
                if (active != null) reject("overlapping-attempt")
                active = attempt(value)
            }
            "chunk" -> {
                value.keysExactly(setOf("type", "attemptId", "revision", "index", "time", "chunk"))
                val attempt = active ?: reject("chunk-without-attempt")
                if (attempt.id != id || attempt.end != null || value.required("index").safeInteger() != attempt.nextIndex) reject("assistant-index-gap")
                value.required("time").safeInteger(-ProtocolLimits.MAX_SAFE_INTEGER)
                chunk(attempt, value.required("chunk").objectValue())
                attempt.nextIndex++
            }
            "end" -> {
                value.keysExactly(setOf("type", "attemptId", "revision", "index", "outcome"))
                val attempt = active ?: reject("end-without-attempt")
                if (attempt.id != id || attempt.end != null || value.required("index").safeInteger() != attempt.nextIndex) reject("assistant-index-gap")
                val outcome = value.required("outcome").objectValue()
                when (outcome.required("kind").stringValue()) {
                    "abandoned" -> {
                        outcome.keysExactly(setOf("kind"))
                        active = null; pendingDurable.clear(); revision = nextRevision
                        return AssistantUpdate.Abandoned(id)
                    }
                    "committed" -> {
                        outcome.keysExactly(setOf("kind", "eventType", "seq"))
                        val type = outcome.required("eventType").stringValue()
                        if (type != "assistant/message" && type != "assistant/attempt") reject("invalid-settlement-type")
                        val end = End(type, outcome.required("seq").safeInteger())
                        if (end.seq <= attempt.startedAfterSeq) reject("invalid-settlement-cut")
                        pendingDurable[end.seq]?.let { verifySettlement(attempt, end, it) }
                        attempt.end = end
                    }
                    else -> reject("invalid-assistant-outcome")
                }
            }
            else -> reject("invalid-assistant-discriminator")
        }
        revision = nextRevision
        return settle() ?: AssistantUpdate.Changed
    }

    @Synchronized fun durable(event: SessionEvent, deliveredGeneration: Long): AssistantUpdate {
        if (deliveredGeneration != generation || !ready) return AssistantUpdate.Ignored
        if (event.type != "assistant/message" && event.type != "assistant/attempt") return AssistantUpdate.Ignored
        val attempt = active ?: return AssistantUpdate.Ignored
        if (event.seq <= attempt.startedAfterSeq) return AssistantUpdate.Ignored
        val data = event.data.objectValue()
        if (data.required("turn").safeInteger() != attempt.turn || data.required("step").safeInteger() != attempt.step) return AssistantUpdate.Ignored
        if (pendingDurable.size >= 64 && event.seq !in pendingDurable) reject("settlement-limit")
        val previous = pendingDurable[event.seq]
        if (previous != null && previous != event) reject("conflicting-settlement")
        attempt.end?.let { end -> if (end.seq == event.seq) verifySettlement(attempt, end, event) }
        pendingDurable[event.seq] = event
        return settle() ?: AssistantUpdate.Changed
    }

    private fun settle(): AssistantUpdate.Settled? {
        val attempt = active ?: return null
        val end = attempt.end ?: return null
        val event = pendingDurable[end.seq] ?: return null
        verifySettlement(attempt, end, event)
        // Atomic canonical replacement avoids duplicate text. Full Web step-end
        // retention/animation is deliberately not implemented by this text view.
        active = null; pendingDurable.clear()
        return AssistantUpdate.Settled(event)
    }
    private fun verifySettlement(attempt: Attempt, end: End, event: SessionEvent) {
        val data = event.data.objectValue()
        if (event.type != end.eventType || event.seq != end.seq || data.required("turn").safeInteger() != attempt.turn || data.required("step").safeInteger() != attempt.step) reject("settlement-mismatch")
    }
    private fun attempt(raw: JsonObject): Attempt = Attempt(opaqueId(raw.required("attemptId").stringValue(160)), raw.required("startedAfterSeq").safeInteger(-1), raw.required("turn").safeInteger(), raw.required("step").safeInteger())

    private fun chunk(attempt: Attempt, raw: JsonObject) {
        val type = raw.required("type").stringValue(160)
        when (type) {
            "text-delta" -> {
                raw.keysExactly(setOf("type", "index", "text"))
                append(attempt, raw.required("index").safeInteger(), raw.required("text").stringValue(), false)
            }
            "block-start" -> {
                raw.keysExactly(setOf("type", "index", "blockType"))
                val index = raw.required("index").safeInteger()
                if (raw.required("blockType").stringValue(160) == "text") attempt.text.getOrPut(index) { StringBuilder() } else extension(attempt, raw)
            }
            "block-end" -> {
                raw.keysExactly(setOf("type", "index", "block"))
                val index = raw.required("index").safeInteger()
                val block = raw.required("block").objectValue()
                if (block.required("type").stringValue(160) == "text") append(attempt, index, block.required("text").stringValue(), true) else extension(attempt, raw)
            }
            "reasoning-delta" -> {
                raw.keysExactly(setOf("type", "index", "text")); raw.required("index").safeInteger(); raw.required("text").stringValue()
                extension(attempt, raw)
            }
            "tool-call-delta" -> {
                raw.keysExactly(setOf("type", "index", "id", "argumentsDelta"), setOf("name"))
                raw.required("index").safeInteger(); opaqueId(raw.required("id").stringValue(160)); raw.required("argumentsDelta").stringValue(); raw.optionalString("name", 160)
                extension(attempt, raw)
            }
            "usage" -> { raw.keysExactly(setOf("type", "usage")); raw.required("usage").objectValue(); extension(attempt, raw) }
            "finish" -> {
                raw.keysExactly(setOf("type", "reason"), setOf("replayState")); raw.required("reason").objectValue().required("kind").stringValue(160)
                extension(attempt, raw)
            }
            else -> { attempt.unsupported += type; extension(attempt, raw) }
        }
    }
    private fun append(attempt: Attempt, index: Long, text: String, replace: Boolean) {
        val total = attempt.text.values.sumOf { it.length }
        val previous = attempt.text[index]?.length ?: 0
        if (total + text.length - (if (replace) previous else 0) > ProtocolLimits.MAX_STRING) reject("assistant-text-limit")
        if (index !in attempt.text && attempt.text.size >= ProtocolLimits.MAX_ITEMS) reject("collection-limit")
        val buffer = attempt.text.getOrPut(index) { StringBuilder() }
        if (replace) buffer.clear()
        buffer.append(text)
    }
    private fun extension(attempt: Attempt, value: JsonObject) {
        val length = value.toString().length
        if (attempt.extensions.size >= ProtocolLimits.MAX_ITEMS || attempt.extensionSize + length > ProtocolLimits.MAX_STRING) reject("assistant-extension-limit")
        attempt.extensionSize += length; attempt.extensions += value
    }
    private fun expand(attempt: Attempt, record: JsonObject) {
        val type = record.required("type").stringValue(160)
        if (type == "chunk") {
            record.keysExactly(setOf("type", "time", "chunk")); record.required("time").safeInteger(-ProtocolLimits.MAX_SAFE_INTEGER)
            chunk(attempt, record.required("chunk").objectValue()); attempt.nextIndex++
            return
        }
        if (type !in setOf("text-chunks", "reasoning-chunks", "tool-call-chunks")) reject("unsupported-compact-record")
        val tool = type == "tool-call-chunks"
        record.keysExactly(if (tool) setOf("type", "time0", "index", "dt", "id", "args") else setOf("type", "time0", "index", "dt", "texts"), if (tool) setOf("name") else emptySet())
        val index = record.required("index").safeInteger()
        var time = record.required("time0").safeInteger(-ProtocolLimits.MAX_SAFE_INTEGER)
        val members = record.required(if (tool) "args" else "texts").arrayValue().map { it.stringValue() }
        val gaps = record.required("dt").arrayValue().map { it.safeInteger(-ProtocolLimits.MAX_SAFE_INTEGER) }
        if (members.isEmpty() || gaps.size != members.size - 1) reject("invalid-compact-run")
        val id = if (tool) opaqueId(record.required("id").stringValue(160)) else null
        val name = record.optionalString("name", 160)
        members.forEachIndexed { position, text ->
            if (position > 0) time += gaps[position - 1]
            if (time < -ProtocolLimits.MAX_SAFE_INTEGER || time > ProtocolLimits.MAX_SAFE_INTEGER) reject("compact-time-range")
            val raw = buildJsonObject {
                put("type", when (type) { "text-chunks" -> "text-delta"; "reasoning-chunks" -> "reasoning-delta"; else -> "tool-call-delta" })
                put("index", index)
                if (tool) { put("id", id ?: reject("invalid-tool-id")); if (name != null) put("name", name); put("argumentsDelta", text) } else put("text", text)
            }
            chunk(attempt, raw); attempt.nextIndex++
        }
    }
}
