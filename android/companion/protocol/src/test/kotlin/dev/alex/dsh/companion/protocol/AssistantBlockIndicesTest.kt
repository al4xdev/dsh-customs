package dev.alex.dsh.companion.protocol

import org.junit.Assert.assertEquals
import org.junit.Test

class AssistantBlockIndicesTest {
    @Test fun textIndicesSurviveReasoningInterleavingAndSnapshotsDoNotMutate() {
        val assembler = AssistantAssembler()
        assembler.baseline(NativeCodec.json("""{"revision":3,"activeAttempt":{"attemptId":"fixture-attempt","startedAfterSeq":0,"turn":1,"step":0,"nextIndex":3,"stream":[{"type":"text-chunks","time0":1,"index":0,"dt":[],"texts":["before"]},{"type":"reasoning-chunks","time0":1,"index":1,"dt":[],"texts":["fixture reasoning"]},{"type":"text-chunks","time0":1,"index":2,"dt":[],"texts":["after"]}]}}""").objectValue(), 0, 0)
        val first = requireNotNull(assembler.state().live)
        assertEquals(mapOf(0L to "before", 2L to "after"), first.textBlocks)
        assertEquals("beforeafter", first.text)
        assembler.frame(NativeCodec.json("""{"type":"chunk","attemptId":"fixture-attempt","revision":4,"index":3,"time":1,"chunk":{"type":"text-delta","index":2,"text":"!"}}""").objectValue(), 0)
        assertEquals("after", first.textBlocks[2L])
        assertEquals("after!", assembler.state().live?.textBlocks?.get(2L))
    }
}
