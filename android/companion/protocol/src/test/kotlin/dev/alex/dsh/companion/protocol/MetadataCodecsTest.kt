package dev.alex.dsh.companion.protocol

import kotlinx.serialization.json.JsonNull
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class MetadataCodecsTest {
    private val uuid = "12345678-1234-4234-8234-123456789abc"
    private val host = """{"version":1,"instanceId":"$uuid","phase":"ready","reason":"ready","pushLoaded":true,"startupCommitted":true,"available":true,"retryable":false,"requiresRecreate":false,"generation":0}"""
    private val catalog = """{"version":1,"profile":"companion","sourceId":"$uuid","revision":0}"""
    private val current = """{"version":1,"profile":"companion","heads":[{"sessionId":"s1","createdAt":0,"knowledge":"current","asOfSeq":3,"continuedCallIds":["call1"]}]}"""
    private val unknown = """{"version":1,"profile":"companion","heads":[{"sessionId":"s1","createdAt":null,"knowledge":"unknown","asOfSeq":null,"continuedCallIds":null}]}"""
    private fun fails(block: () -> Unit): ProtocolException = assertThrows(ProtocolException::class.java, block)
    private fun heads(raw: String) = InteractionHeadsCodec.read(raw, setOf("s1")).getValue("s1")

    @Test fun exactHostFieldsAndKnownPhasesDecodeWithoutInventedReadinessRules() {
        val actual = HostStatusCodec.read(host)
        assertEquals(HostStatus(1, uuid, HostPhase.READY, "ready", true, true, true, false, false, 0), actual)
        for (phase in listOf("pending", "ready", "suspended", "reconciling", "stale", "closed")) {
            assertEquals(phase, HostStatusCodec.read(host.replace("\"phase\":\"ready\"", "\"phase\":\"$phase\"")).phase.wire)
        }
        // The producer validates fields independently. A DTO must not fabricate or demand extra cross-field invariants.
        assertFalse(HostStatusCodec.read(host.replace("\"available\":true", "\"available\":false")).available)
        assertEquals("future-stable-reason", HostStatusCodec.read(host.replace("\"reason\":\"ready\"", "\"reason\":\"future-stable-reason\"")).reason)
    }

    @Test fun hostRejectsUnknownMissingExtraAndCoercedFields() {
        for (raw in listOf(
            host.replace("\"version\":1", "\"version\":2"), host.replace("\"phase\":\"ready\"", "\"phase\":\"armed\""),
            host.replace("\"available\":true", "\"available\":\"true\""), host.replace("\"available\":true,", ""),
            host.replace("\"generation\":0", "\"generation\":-1"), host.replace("\"generation\":0", "\"generation\":9007199254740992"),
            host.replace("\"reason\":\"ready\"", "\"reason\":\"RAW diagnostic / body\""),
            host.replace("\"generation\":0", "\"generation\":0,\"control\":null"),
            host.replace("\"pushLoaded\":true", "\"pushLoaded\":null"),
        )) fails { HostStatusCodec.read(raw) }
        fails { HostStatusCodec.decode(JsonNull) }
    }

    @Test fun hostInstanceIsOnlyAnAssemblyDiagnosticAndNeverAnInventedBootCounter() {
        val newer = HostStatusCodec.read(host.replace(uuid, "22345678-1234-4234-8234-123456789abc"))
        assertNotEquals(HostStatusCodec.read(host).instanceId, newer.instanceId)
        assertEquals(0L, newer.generation)
        // No ledger/answer/reset mutation API or boot field is part of this codec's output.
        fails { HostStatusCodec.read(host.replace("\"generation\":0", "\"generation\":0,\"backendBootId\":\"invented\"")) }
    }

    @Test fun lowerV4UuidRequiredOnBothIndependentSourceDtos() {
        for (bad in listOf(uuid.uppercase(), uuid.replace("-4234-", "-5234-"), uuid.replace("-8234-", "-7234-"), "not-a-uuid")) {
            fails { HostStatusCodec.read(host.replace(uuid, bad)) }
            fails { CatalogStateCodec.read(catalog.replace(uuid, bad)) }
        }
    }

    @Test fun catalogCounterIsScopedMetadataAndAcceptsZeroAndJsSafeMaximum() {
        assertEquals(CatalogState(1, "companion", uuid, 0), CatalogStateCodec.read(catalog))
        assertEquals(ProtocolLimits.MAX_SAFE_INTEGER, CatalogStateCodec.read(catalog.replace("\"revision\":0", "\"revision\":9007199254740991")).revision)
        assertEquals(CatalogStateCodec.read(catalog), CatalogStateCodec.decode(WireJson.parse(catalog)))
    }

    @Test fun catalogRejectsWrongProfileVersionKeysAndUnsafeNumbers() {
        for (raw in listOf(catalog.replace("companion", "other"), catalog.replace("\"version\":1", "\"version\":0"),
            catalog.replace("\"revision\":0", "\"revision\":-1"), catalog.replace("\"revision\":0", "\"revision\":9007199254740992"),
            catalog.replace("\"revision\":0", "\"revision\":0.0"), catalog.replace("\"revision\":0", "\"revision\":\"0\""),
            catalog.replace("\"revision\":0", "\"revision\":0,\"timestamp\":1"), catalog.replace("\"revision\":0", "\"revision\":null"))) {
            fails { CatalogStateCodec.read(raw) }
        }
    }

    @Test fun currentCandidateAndUnknownNullRemainDistinctAndCannotGrantControls() {
        assertEquals(InteractionHead("s1", 0, InteractionHeadKnowledge.CURRENT, 3, listOf("call1")), heads(current))
        assertEquals(InteractionHeadKnowledge.UNKNOWN, heads(unknown).knowledge)
        assertNull(heads(unknown).createdAt); assertNull(heads(unknown).asOfSeq); assertNull(heads(unknown).continuedCallIds)
        assertEquals(0L, heads(unknown.replace("\"createdAt\":null", "\"createdAt\":0")).createdAt)
        val empty = current.replace("\"asOfSeq\":3", "\"asOfSeq\":-1").replace("[\"call1\"]", "[]")
        assertEquals(emptyList<String>(), heads(empty).continuedCallIds)
        assertEquals(-1L, heads(empty).asOfSeq)
    }

    @Test fun interactionKnowledgeAndNumberInvariantsFailClosed() {
        for (raw in listOf(current.replace("\"createdAt\":0", "\"createdAt\":null"),
            current.replace("\"createdAt\":0", "\"createdAt\":-1"), current.replace("\"asOfSeq\":3", "\"asOfSeq\":-2"),
            current.replace("\"asOfSeq\":3", "\"asOfSeq\":null"), current.replace("\"asOfSeq\":3", "\"asOfSeq\":9007199254740992"),
            current.replace("\"asOfSeq\":3", "\"asOfSeq\":3.0"), current.replace("[\"call1\"]", "null"),
            current.replace("\"knowledge\":\"current\"", "\"knowledge\":\"unavailable\""),
            unknown.replace("\"continuedCallIds\":null", "\"continuedCallIds\":[]"), unknown.replace("\"asOfSeq\":null", "\"asOfSeq\":0"))) {
            fails { heads(raw) }
        }
    }

    @Test fun exactViewportHasNoDuplicatesForeignOrMissingRows() {
        fails { InteractionHeadsCodec.read(current, setOf("other")) }
        fails { InteractionHeadsCodec.read(current, setOf("s1", "s2")) }
        fails { InteractionHeadsCodec.read(current, emptySet()) }
        val row = current.substringAfter("\"heads\":[").dropLast(2)
        fails { heads("""{"version":1,"profile":"companion","heads":[$row,$row]}""") }
        assertTrue(InteractionHeadsCodec.read("""{"version":1,"profile":"companion","heads":[]}""", emptySet()).isEmpty())
        fails { InteractionHeadsCodec.read("""{"version":1,"profile":"companion","heads":[]}""", (0..20).map { "s$it" }.toSet()) }
    }

    @Test fun interactionForbidsQuestionBodiesPermitsAndWrongScope() {
        for (raw in listOf(current.replace("\"heads\":", "\"permit\":null,\"heads\":"),
            current.replace("\"createdAt\":0", "\"question\":\"PRIVATE-BODY\",\"createdAt\":0"),
            current.replace("companion", "foreign"), current.replace("\"version\":1", "\"version\":2"))) {
            val error = fails { heads(raw) }
            assertFalse(error.message.orEmpty().contains("PRIVATE-BODY"))
        }
    }

    @Test fun sessionIdMatchesBackend160CharacterAsciiDomain() {
        for (id in listOf("_synthetic", "-synthetic", "a".repeat(160))) {
            assertEquals(id, InteractionHeadsCodec.read(current.replace("s1", id), setOf(id)).getValue(id).sessionId)
        }
        for (id in listOf("", "a".repeat(161), "../private", "with space", "é", "s\n1")) {
            fails { CompanionMetadataRequests.interactionHeads("r1", listOf(id)) }
        }
    }

    @Test fun callIdsRejectDuplicatesOversizeWhitespaceControlAndAstralFormatCharacters() {
        for (value in listOf("", " call1", "call1 ", "x".repeat(257), "c\u200bd", "c\uDB40\uDC01d", "c\nd")) {
            val encoded = kotlinx.serialization.json.JsonPrimitive(value).toString()
            fails { heads(current.replace("[\"call1\"]", "[$encoded]")) }
        }
        fails { heads(current.replace("[\"call1\"]", "[\"call1\",\"call1\"]")) }
        val max = "x".repeat(256)
        assertEquals(listOf(max), heads(current.replace("[\"call1\"]", "[\"$max\"]")).continuedCallIds)
        val many = (0..32).joinToString(",") { "\"call$it\"" }
        fails { heads(current.replace("[\"call1\"]", "[$many]")) }
    }

    @Test fun allRawDecodersRejectDuplicatesBeforeLibraryObjectOverwrite() {
        fails { HostStatusCodec.read(host.replace("\"version\":1", "\"version\":1,\"version\":1")) }
        fails { CatalogStateCodec.read(catalog.replace("\"revision\":0", "\"revision\":0,\"revision\":0")) }
        fails { heads(current.replace("\"asOfSeq\":3", "\"asOfSeq\":3,\"asOfSeq\":3")) }
    }

    @Test fun metadataOriginalWireWhitespaceAndUtf8BudgetIs32KiB() {
        for (read in listOf<() -> Unit>(
            { HostStatusCodec.read(" ".repeat(32768) + host) },
            { CatalogStateCodec.read(" ".repeat(32768) + catalog) },
            { heads(" ".repeat(32768) + current) },
            { CatalogStateCodec.read(catalog.replace("companion", "é".repeat(17000))) },
        )) assertEquals("metadata-too-large", fails(read).code)
    }

    @Test fun decodersConsumeSuccessfulUnaryValueNotEnvelope() {
        val wrapped = """{"type":"server-response","rpcId":"r1","ok":true,"value":$host}"""
        fails { HostStatusCodec.read(wrapped) }
        fails { CatalogStateCodec.read(wrapped) }
        fails { InteractionHeadsCodec.read(wrapped, emptySet()) }
        assertEquals(HostStatusCodec.read(host), HostStatusCodec.decode(WireJson.parse(host)))
        assertEquals(heads(current), InteractionHeadsCodec.decode(WireJson.parse(current), setOf("s1")).getValue("s1"))
    }

    @Test fun fixedRequestsUseNativeEnvelopeAndCorrectEmptyArgumentConventions() {
        val status = """{"type":"client-request","rpcId":"r1","method":"companionHost/status","payload":{"args":{}}}"""
        val catalogRequest = """{"type":"client-request","rpcId":"r1","method":"companion/catalogState","payload":{"args":{"request":{}}}}"""
        val interaction = """{"type":"client-request","rpcId":"r1","method":"companion/interactionHeads","payload":{"args":{"request":{"sessionIds":["s1"]}}}}"""
        assertEquals(WireJson.parse(status), WireJson.parse(CompanionMetadataRequests.hostStatus("r1")))
        assertEquals(WireJson.parse(catalogRequest), WireJson.parse(CompanionMetadataRequests.catalogState("r1")))
        assertEquals(WireJson.parse(interaction), WireJson.parse(CompanionMetadataRequests.interactionHeads("r1", listOf("s1"))))
        assertTrue(CompanionMetadataRequests.interactionHeads("r1", emptyList()).contains("\"sessionIds\":[]"))
    }

    @Test fun requestBuildersRejectUnsafeCorrelationAndDuplicateOrOversizedViewport() {
        fails { CompanionMetadataRequests.hostStatus("") }
        fails { CompanionMetadataRequests.catalogState("r\n1") }
        fails { CompanionMetadataRequests.interactionHeads("r1", listOf("s1", "s1")) }
        fails { CompanionMetadataRequests.interactionHeads("r1", (0..20).map { "s$it" }) }
    }
}
