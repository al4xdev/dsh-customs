package dev.alex.dsh.companion.net

import dev.alex.dsh.companion.protocol.MuxFrame
import dev.alex.dsh.companion.protocol.NativeCodec
import dev.alex.dsh.companion.protocol.ProtocolException
import dev.alex.dsh.companion.protocol.RemoteEventFrame
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class EventItemDecodeTest {
    private fun item(value: String) = NativeCodec.mux("""{"type":"item","streamId":"events","value":$value}""") as MuxFrame.Item

    @Test fun undecodableWaterfallEnvelopeIsIsolatedWithItsIdentityOnly() {
        val decoded = decodeEventItem(item("""{"type":"waterfall","event":"approval/request","eventId":"event-1","agentId":"chat-a","request":{"toolName":"synthetic-tool"},"futureEnvelope":1}"""))
        assertNull(decoded.remoteEvent)
        assertEquals(UnsupportedWaterfall("approval/request", "event-1", "chat-a"), decoded.unsupportedWaterfall)
        val notAnObject = decodeEventItem(item("""{"type":"waterfall","event":"user-questions/request","eventId":"event-2","agentId":"chat-a","request":[]}"""))
        assertEquals("event-2", notAnObject.unsupportedWaterfall?.eventId)
    }

    @Test fun decodableFramesAreUnchangedAndCarryNoMarker() {
        val cancel = decodeEventItem(item("""{"type":"cancel","eventId":"event-1"}"""))
        assertTrue(cancel.remoteEvent is RemoteEventFrame.Cancel)
        assertNull(cancel.unsupportedWaterfall)
        val waterfall = decodeEventItem(item("""{"type":"waterfall","event":"approval/request","eventId":"event-1","agentId":"chat-a","request":{"toolName":"synthetic-tool"}}"""))
        assertTrue(waterfall.remoteEvent is RemoteEventFrame.Waterfall)
        assertNull(waterfall.unsupportedWaterfall)
    }

    @Test fun everyOtherMalformedEventFrameStillFailsTheCarrier() {
        listOf(
            """{"type":"ready","clientId":"client"}""",
            """{"type":"future-frame"}""",
            """{"type":"cancel","eventId":"event-1","extra":true}""",
            // A waterfall without a usable identity cannot even be marked.
            """{"type":"waterfall","event":"approval/request","eventId":"event-1","agentId":"../foreign","request":{},"x":1}""",
            """{"type":"waterfall","event":"approval/request","agentId":"chat-a","request":{},"x":1}""",
            """{"type":"waterfall","event":"approval/request","eventId":"","agentId":"chat-a","request":{},"x":1}""",
        ).forEach { raw ->
            assertThrows(ProtocolException::class.java) { decodeEventItem(item(raw)) }
        }
    }
}
