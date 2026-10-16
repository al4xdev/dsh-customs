package dev.alex.dsh.companion.protocol

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

sealed interface JournalUpdate {
    data object Ignored : JournalUpdate
    data object Replaced : JournalUpdate
    data class Appended(val event: SessionEvent) : JournalUpdate
    data object Prepended : JournalUpdate
    data class RepairRequired(val throughSeq: Long) : JournalUpdate
    data class Assistant(val frame: JsonObject) : JournalUpdate
}
data class JournalState(val generation: Long, val ready: Boolean, val cursor: Long, val records: List<SessionEvent>, val hasMore: Boolean, val header: SessionHeader?)

/** A single caller-owned session lifetime; it never starts/cancels an Agent. */
class SessionJournal(private val admission: CompanionAdmission) {
    private var generation = admission.generation
    private var ready = false
    private var cursor = -1L
    private var records = emptyList<SessionEvent>()
    private var hasMore = false
    private var header: SessionHeader? = null
    private var needsRepair = false
    private var repairThrough = -1L
    // Cursor alone does not identify a window: prepend/repair can change records at the same cut.
    private var recordsRevision = 0L

    @Synchronized fun recordsRevision(): Long = recordsRevision
    /** Immutable admitted metadata only; stream guards must not copy the entire record window. */
    @Synchronized fun readyHeader(): SessionHeader? = header.takeIf { ready }
    @Synchronized fun state(): JournalState = JournalState(generation, ready, cursor, records.toList(), hasMore, header)
    @Synchronized fun beginGeneration(value: Long) {
        if (value <= generation) reject("generation-not-increasing")
        generation = value
        ready = false
        needsRepair = false; repairThrough = -1
        // Hold the published window until a replacement opening is validated.
    }
    @Synchronized fun apply(frame: FollowFrame, deliveredGeneration: Long): JournalUpdate {
        if (deliveredGeneration != generation) return JournalUpdate.Ignored
        return when (frame) {
            is FollowFrame.Snapshot -> {
                if (ready) reject("duplicate-opening")
                if (frame.header.id != admission.sessionId || frame.header.agentPreset != "companion" || frame.header.raw["origin"] != null) reject("follow-admission-mismatch")
                if (frame.cursor < cursor) reject("cursor-regression")
                validatePage(frame.page, frame.cursor)
                if (frame.projections.asOfSeq > frame.cursor) reject("projection-past-cursor")
                records = frame.page.records.toList(); cursor = frame.cursor; hasMore = frame.page.hasMore; header = frame.header
                recordsRevision++
                ready = true; needsRepair = false; repairThrough = -1
                JournalUpdate.Replaced
            }
            is FollowFrame.Event -> {
                if (!ready) reject("event-before-opening")
                val event = frame.event
                if (event.seq <= cursor) {
                    val previous = records.find { it.seq == event.seq }
                    if (previous != null && previous != event) reject("conflicting-duplicate")
                    JournalUpdate.Ignored
                } else if (needsRepair || event.seq != cursor + 1) {
                    needsRepair = true; repairThrough = maxOf(repairThrough, event.seq)
                    JournalUpdate.RepairRequired(repairThrough)
                } else {
                    if (records.size >= ProtocolLimits.MAX_ITEMS) reject("journal-limit")
                    records = records + event; cursor = event.seq
                    recordsRevision++
                    JournalUpdate.Appended(event)
                }
            }
            is FollowFrame.Assistant -> {
                if (!ready) reject("assistant-before-opening")
                if (needsRepair) JournalUpdate.Ignored else JournalUpdate.Assistant(frame.frame)
            }
        }
    }

    /** Same-generation bounded repair replaces the window through its known cut. */
    @Synchronized fun repair(page: HistoryPage, throughSeq: Long, deliveredGeneration: Long): JournalUpdate {
        if (deliveredGeneration != generation) return JournalUpdate.Ignored
        if (!ready || throughSeq < cursor) reject("invalid-repair-cut")
        if (throughSeq < repairThrough) return JournalUpdate.RepairRequired(repairThrough)
        validatePage(page, throughSeq)
        records = page.records.toList(); cursor = throughSeq; hasMore = page.hasMore; needsRepair = false; repairThrough = -1
        recordsRevision++
        return JournalUpdate.Replaced
    }

    @Synchronized fun prepend(page: HistoryPage, throughSeq: Long, beforeSeq: Long, deliveredGeneration: Long): JournalUpdate {
        if (deliveredGeneration != generation) return JournalUpdate.Ignored
        if (!ready || needsRepair || throughSeq > cursor || throughSeq < -1) reject("invalid-page-cut")
        val first = records.firstOrNull()?.seq ?: reject("empty-history")
        // Another backward page may have won while this HTTP request was pending.
        if (beforeSeq != first) return JournalUpdate.Ignored
        contiguous(page.records)
        if (page.records.isEmpty()) {
            if (page.hasMore || beforeSeq > 0) reject("history-no-progress")
            hasMore = false
            return JournalUpdate.Ignored
        }
        if (page.records.any { it.seq >= beforeSeq || it.seq > throughSeq }) reject("non-exclusive-page")
        if (page.records.last().seq + 1 != first) reject("page-gap")
        validateMore(page)
        if (page.records.size + records.size > ProtocolLimits.MAX_ITEMS) reject("journal-limit")
        records = page.records.toList() + records; hasMore = page.hasMore
        recordsRevision++
        return JournalUpdate.Prepended
    }

    private fun validatePage(page: HistoryPage, throughSeq: Long) {
        if (throughSeq < -1 || throughSeq > ProtocolLimits.MAX_SAFE_INTEGER) reject("integer-range")
        contiguous(page.records)
        if (throughSeq == -1L) {
            if (page.records.isNotEmpty() || page.hasMore) reject("invalid-empty-snapshot")
        } else if (page.records.lastOrNull()?.seq != throughSeq) reject("page-misses-cursor")
        validateMore(page)
    }
    private fun validateMore(page: HistoryPage) {
        val first = page.records.firstOrNull()
        if (first != null && page.hasMore != (first.seq > 0)) reject("invalid-history-cut")
    }
    private fun contiguous(events: List<SessionEvent>) {
        if (events.size > ProtocolLimits.MAX_ITEMS) reject("journal-limit")
        events.forEachIndexed { index, event ->
            if (event.seq < 0 || event.seq > ProtocolLimits.MAX_SAFE_INTEGER) reject("integer-range")
            if (index > 0 && events[index - 1].seq + 1 != event.seq) reject("noncontiguous-page")
        }
    }
}

/** Cached watermark values are deliberately never compared to live seq values. */
class ProjectionStore {
    private data class Row(val value: JsonElement, val seq: Long?)
    private var generation = -1L
    private var rows = emptyMap<String, Row>()
    private var baselineCut: Long? = null

    @Synchronized fun beginGeneration(value: Long) {
        if (value < 0 || value <= generation) reject("generation-not-increasing")
        generation = value; rows = emptyMap(); baselineCut = null
    }
    @Synchronized fun values(): JsonObject = JsonObject(rows.mapValues { it.value.value })
    @Synchronized fun cached(values: JsonObject, deliveredGeneration: Long) {
        if (deliveredGeneration != generation) return
        WireJson.validate(values)
        rows = rows + values.filterKeys { rows[it]?.seq == null && baselineCut == null }.mapValues { Row(it.value, null) }
    }
    @Synchronized fun seed(baseline: ProjectionBaseline, deliveredGeneration: Long) {
        if (deliveredGeneration != generation) return
        if (baseline.asOfSeq < (baselineCut ?: -1L)) return
        WireJson.validate(baseline.values)
        val newer = rows.filterValues { it.seq != null && it.seq > baseline.asOfSeq }
        rows = baseline.values.mapValues { Row(it.value, baseline.asOfSeq) } + newer
        baselineCut = baseline.asOfSeq
    }
    @Synchronized fun update(key: String, value: JsonElement, seq: Long, deliveredGeneration: Long) {
        if (deliveredGeneration != generation) return
        if (seq < -1 || seq > ProtocolLimits.MAX_SAFE_INTEGER || key.isBlank() || key.length > 160) reject("invalid-projection")
        WireJson.validate(value)
        val previous = rows[key]?.seq
        val cut = baselineCut
        if ((cut != null && seq <= cut) || (previous != null && seq <= previous)) return
        if (key !in rows && rows.size >= ProtocolLimits.MAX_ITEMS) reject("collection-limit")
        rows = rows + (key to Row(value, seq))
    }
}
