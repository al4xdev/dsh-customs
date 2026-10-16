package dev.alex.dsh.companion.render

import dev.alex.dsh.companion.protocol.AssistantLive
import dev.alex.dsh.companion.protocol.SessionEvent
import dev.alex.dsh.companion.ui.MessageRole
import kotlinx.serialization.json.JsonObject

/** A pure client transform over already-admitted records. It confers no backend capability. */
object RichTranscriptProjection {
    private data class Call(val seq: Long, val turn: Long?, val tool: ToolPresentation)

    fun render(events: List<SessionEvent>, live: AssistantLive?, showModelContext: Boolean = false): List<RichMessage> {
        val surface = linkedMapOf<Long, RichMessage>()
        val calls = linkedMapOf<String, Call>()
        val rowForCall = mutableMapOf<String, Long>()
        val imageCalls = mutableMapOf<String, ToolPresentation>()
        val seenImageCallIds = mutableSetOf<String>()
        val unique = events.distinctBy { it.seq }.sortedBy { it.seq }
        var liveSeq = (unique.lastOrNull()?.seq ?: -1) + 1
        for (event in unique) {
            val data = event.data as? JsonObject
            val replacement = event.surfaceOp as? JsonObject
            if (replacement != null && event.type in setOf("user/message", "assistant/message", "tool/result", "system/message", "developer/message")) {
                val start = RichJson.integer(replacement["startSeq"])
                val end = RichJson.integer(replacement["endSeq"])
                if (RichJson.string(replacement["op"]) == "replace" && start != null && end != null && start <= end && end < event.seq) {
                    val withdrawn = surface.filterValues { message -> message.sourceSeqs.any { it in start..end } }.keys
                    withdrawn.toList().forEach(surface::remove)
                    rowForCall.entries.removeAll { it.value in withdrawn }
                    imageCalls.entries.removeAll { (_, tool) -> tool.callSeq?.let { it in start..end } == true }
                }
            }
            if (ModelContextVisibility.isHidden(event, showModelContext)) continue
            when (event.type) {
                "user/message" -> {
                    if (InternalGoalContinuation.isHidden(event)) continue
                    surface[event.seq] = message(event, MessageRole.USER, data?.get("content"))
                }
                "assistant/message" -> {
                    val turn = RichJson.integer(data?.get("turn"))
                    val step = RichJson.integer(data?.get("step"))
                    // Only one presentation remains while the protocol waits for its end frame.
                    if (live != null && turn == live.turn && step == live.step) { liveSeq = event.seq; continue }
                    val body = data?.get("message") as? JsonObject
                    surface[event.seq] = message(event, MessageRole.ASSISTANT, body?.get("content")).copy(
                        stableId = if (turn != null && step != null) "assistant:$turn:$step" else "event:${event.seq}",
                        interrupted = RichJson.boolean(data?.get("interrupted")) == true,
                        turn = turn, step = step, usagePreview = data?.get("usage")?.let(RichJson::preview),
                    )
                }
                "tool/call", "tool/ptc-dispatch-start" -> {
                    val nested = event.type == "tool/ptc-dispatch-start"
                    val callId = RichJson.id(data?.get(if (nested) "subCallId" else "callId"))
                    if (callId == null) { surface[event.seq] = notice(event, "Ferramenta sem identidade; apresentação indisponível"); continue }
                    val args = if (nested) data?.get("arguments")?.toString() else RichJson.string(data?.get("arguments"))
                    val tool = ToolPresentation(callId, RichJson.string(data?.get("name"))?.take(160), ToolPhase.RUNNING, args,
                        parentCallId = if (nested) RichJson.id(data?.get("parentCallId")) else null,
                        rootCallId = if (nested) RichJson.id(data?.get("rootCallId")) else null, callSeq = event.seq,
                        turn = RichJson.integer(data?.get("turn")), step = RichJson.integer(data?.get("step")))
                    val derived = ToolDetailsProjection.derive(tool, null)
                    // Keep original dispatch data separate from later assistant-preview fallback.
                    if (seenImageCallIds.add(callId)) imageCalls[callId] = tool else imageCalls.remove(callId)
                    calls[callId] = Call(event.seq, RichJson.integer(data?.get("turn")), derived)
                    rowForCall[callId]?.let(surface::remove)
                    rowForCall[callId] = event.seq
                    surface[event.seq] = toolMessage(event.seq, derived, listOf(event.seq))
                }
                "tool/result", "tool/ptc-dispatch" -> {
                    val nested = event.type == "tool/ptc-dispatch"
                    val body = if (nested) data else data?.get("message") as? JsonObject
                    val callId = RichJson.id(if (nested) data?.get("subCallId") else body?.get("toolCallId"))
                    val sourceId = if (nested) callId else RichJson.id((body?.get("source") as? JsonObject)?.get("callId"))
                    if (callId == null || (sourceId != null && sourceId != callId)) {
                        surface[event.seq] = notice(event, "Resultado sem identidade coerente; não associado a outra chamada")
                        continue
                    }
                    val call = calls[callId]
                    val orphan = call?.tool ?: ToolPresentation(callId, if (nested) RichJson.string(data?.get("name")) else null, ToolPhase.UNKNOWN,
                        if (nested) data?.get("arguments")?.toString() else null,
                        parentCallId = if (nested) RichJson.id(data?.get("parentCallId")) else null,
                        rootCallId = if (nested) RichJson.id(data?.get("rootCallId")) else null)
                    val errorFlag = RichJson.boolean(body?.get("isError"))
                    val error = (data?.get("error") as? JsonObject)?.takeIf { errorFlag == true }
                    val blocks = RichJson.blocks(body?.get("content"))
                    val phase = when (errorFlag) {
                        true -> ToolPhase.ERROR
                        false -> ToolPhase.OK
                        null -> if (!nested && body != null && "isError" !in body) ToolPhase.OK else ToolPhase.UNKNOWN
                    }
                    val result = orphan.copy(phase = phase, content = blocks,
                        error = error?.let { ToolError(RichJson.string(it["name"]), RichJson.string(it["code"]), RichJson.string(it["reason"])?.take(RichRenderLimits.MAX_TEXT)) }, resultSeq = event.seq,
                        turn = orphan.turn ?: RichJson.integer(data?.get("turn")), step = orphan.step ?: RichJson.integer(data?.get("step")))
                    val detailed = ToolDetailsProjection.derive(result, data?.get("meta"))
                    val originalImageCall = imageCalls.remove(callId)
                    val derived = detailed.copy(nativeImageReceipt = if (nested || sourceId == callId)
                        NativeImageReceipts.confirm(originalImageCall, detailed) else null)
                    val anchor = rowForCall.remove(callId)?.also(surface::remove) ?: event.seq
                    rowForCall[callId] = anchor
                    surface[anchor] = toolMessage(anchor, derived, listOfNotNull(call?.seq, event.seq).distinct())
                    if (call != null) calls[callId] = call.copy(tool = derived)
                }
                "turn/end" -> {
                    val reason = data?.get("reason") as? JsonObject
                    val kind = RichJson.string(reason?.get("kind")) ?: "unknown"
                    val turn = RichJson.integer(data?.get("turn"))
                    calls.values.filter { it.turn == turn && it.tool.resultSeq == null }.forEach { call ->
                        val anchor = rowForCall[call.tool.callId] ?: return@forEach
                        val current = surface[anchor] ?: return@forEach
                        val phase = if (kind in setOf("aborted", "interrupted", "forked")) ToolPhase.STOPPED else ToolPhase.UNKNOWN
                        surface[anchor] = current.copy(tool = current.tool?.copy(phase = phase))
                    }
                    if (kind != "completed") surface[event.seq] = notice(event, "Turno: $kind", reason?.let(RichJson::preview) ?: "")
                }
                "assistant/attempt" -> surface[event.seq] = notice(event, "Tentativa sem mensagem durável; não é resposta concluída")
                "compaction/summary", "compaction/prune", "compaction/start", "compaction/end", "feedback/message-delete", "feedback/message-put", "image/offload" ->
                    surface[event.seq] = notice(event, "Registro ${event.type}; projeção avançada não reconstruída", RichJson.preview(event.data))
                "llm/retry", "llm/retry-started" -> surface[event.seq] = notice(event, "Nova tentativa do modelo; nenhuma execução pelo renderer")
                "system/message", "developer/message" -> {
                    // These are context, not permission grants or a foreign-chat control surface.
                    val body = data?.get("message") as? JsonObject
                    val content = RichJson.blocks(body?.get("content"))
                    if (content.isNotEmpty() && content.any { it !is RenderBlock.Text || it.text.isNotEmpty() }) surface[event.seq] =
                        RichMessage(event.seq, MessageRole.NOTICE, RichJson.literal(content), content, stableId = "event:${event.seq}")
                }
                else -> if (event.ignorable) surface[event.seq] = notice(event, "Evento não suportado: ${event.type.take(160)}; inerte")
            }
        }
        if (live != null) {
            val blocks = liveBlocks(live)
            if (blocks.isNotEmpty()) surface[liveSeq] = RichMessage(liveSeq, MessageRole.ASSISTANT, RichJson.literal(blocks), blocks,
                stableId = "assistant:${live.turn}:${live.step}", streaming = true, sourceSeqs = emptyList(),
                turn = live.turn, step = live.step, attemptId = live.attemptId, nextIndex = live.nextIndex,
                usagePreview = live.extensions.mapNotNull { raw -> (raw as? JsonObject)?.takeIf { RichJson.string(it["type"]) == "usage" }?.get("usage") }.lastOrNull()?.let(RichJson::preview),
                finishReason = live.extensions.mapNotNull { raw -> ((raw as? JsonObject)?.takeIf { RichJson.string(it["type"]) == "finish" }?.get("reason") as? JsonObject)?.let { reason -> RichJson.string(reason["kind"]) } }.lastOrNull())
        }
        return ToolTimelineProjection.project(surface.values.sortedBy { it.seq })
    }

    private fun message(event: SessionEvent, role: MessageRole, content: kotlinx.serialization.json.JsonElement?): RichMessage {
        val blocks = RichJson.blocks(content)
        val data = event.data as? JsonObject
        // Carry the public discriminant; a rendered assistant role alone is not model provenance.
        val source = when (event.type) {
            "user/message" -> data?.get("source")
            "assistant/message" -> (data?.get("message") as? JsonObject)?.get("source")
            else -> null
        } as? JsonObject
        return RichMessage(event.seq, role, RichJson.literal(blocks), blocks, sourceKind = RichJson.string(source?.get("kind")),
            provenanceSeqs = (event.sourceEventSeqs as? kotlinx.serialization.json.JsonArray)?.take(RichRenderLimits.MAX_BLOCKS)?.mapNotNull(RichJson::integer) ?: emptyList())
    }
    private fun notice(event: SessionEvent, text: String, diagnostic: String = ""): RichMessage = RichMessage(event.seq, MessageRole.NOTICE, text,
        listOf(RenderBlock.Unsupported(event.type, text, diagnostic)), stableId = "event:${event.seq}")
    private fun toolMessage(seq: Long, tool: ToolPresentation, sourceSeqs: List<Long>) = RichMessage(seq, MessageRole.TOOL,
        listOfNotNull(tool.name, tool.argsRaw, RichJson.literal(tool.content).takeIf { it.isNotEmpty() }).joinToString("\n"), tool.content, tool, "tool:${tool.callId}", sourceSeqs = sourceSeqs)

    private fun liveBlocks(live: AssistantLive): List<RenderBlock> {
        val indexed = sortedMapOf<Long, List<RenderBlock>>()
        live.textBlocks.entries.take(RichRenderLimits.MAX_BLOCKS).forEach { (index, text) -> indexed[index] = listOf(RenderBlock.Text(text)) }
        val reasoning = mutableMapOf<Long, StringBuilder>()
        val tools = mutableMapOf<Long, RenderBlock.ToolCall>()
        val diagnostics = mutableListOf<RenderBlock>()
        live.extensions.take(RichRenderLimits.MAX_TREE_NODES).forEach { element ->
            val chunk = element as? JsonObject ?: return@forEach
            val type = RichJson.string(chunk["type"])
            val index = RichJson.integer(chunk["index"])
            when (type) {
                "reasoning-delta" -> if (index != null) {
                    val text = RichJson.string(chunk["text"]) ?: ""
                    val buffer = reasoning.getOrPut(index) { StringBuilder() }
                    buffer.append(text)
                    indexed[index] = listOf(RenderBlock.Reasoning(buffer.toString()))
                }
                "tool-call-delta" -> if (index != null) {
                    val id = RichJson.id(chunk["id"]) ?: return@forEach
                    val previous = tools[index]
                    if (previous != null && previous.callId != id) {
                        indexed[index] = listOf(RenderBlock.Unsupported("tool-call-delta", "Identidade de chamada alterada; argumentos não executáveis"))
                    } else {
                        val raw = previous?.argsRaw.orEmpty() + RichJson.string(chunk["argumentsDelta"]).orEmpty()
                        val block = RenderBlock.ToolCall(id, RichJson.string(chunk["name"]) ?: previous?.name, raw, preparing = true)
                        tools[index] = block; indexed[index] = listOf(block)
                    }
                }
                "block-end" -> if (index != null && chunk["block"] != null) indexed[index] = RichJson.block(chunk.getValue("block"))
                "block-start", "usage", "finish" -> Unit
                else -> diagnostics += RenderBlock.Unsupported(type?.take(160) ?: "chunk", "Fragmento não suportado; apresentação inerte", RichJson.preview(chunk))
            }
        }
        val fallback = if (live.textBlocks.isEmpty() && live.text.isNotEmpty()) listOf(RenderBlock.Text(live.text)) else emptyList()
        val lostOrder = if (fallback.isNotEmpty() && indexed.isNotEmpty()) listOf(RenderBlock.Unsupported("legacy-live", "Ordem dos blocos de texto indisponível neste snapshot")) else emptyList()
        val unknown = live.unsupportedKinds.take(32).map { RenderBlock.Unsupported(it.take(160), "Tipo de stream não suportado") }
        val streamLimit = if (live.extensions.size > RichRenderLimits.MAX_TREE_NODES || live.textBlocks.size > RichRenderLimits.MAX_BLOCKS) listOf(RenderBlock.Unsupported("stream", "Mais fragmentos não exibidos; limite de apresentação")) else emptyList()
        return RenderBlockBudget.bound(fallback + indexed.values.flatten() + lostOrder + diagnostics + unknown + streamLimit)
    }
}
