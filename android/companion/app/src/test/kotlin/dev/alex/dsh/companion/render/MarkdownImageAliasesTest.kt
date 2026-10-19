package dev.alex.dsh.companion.render

import dev.alex.dsh.companion.protocol.SessionEvent
import dev.alex.dsh.companion.ui.MessageRole
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MarkdownImageAliasesTest {
    private val path = "/synthetic/images/fixture.png"
    private val args = """{"file_path":"$path"}"""
    private val explicit = "attachment:fixture-opaque-image"
    private fun content(image: kotlinx.serialization.json.JsonElement = RichFixtures.image) = buildJsonArray {
        add(RichFixtures.text("<path>$path</path>\n<type>image</type>")); add(image)
    }
    private fun source(call: SessionEvent = RichFixtures.call(1, "read_image", args),
        result: SessionEvent = RichFixtures.result(2, content()), answerSeq: Long = 3): List<RichMessage> =
        RichTranscriptProjection.render(listOf(call, result, RichFixtures.assistant(answerSeq, "Before ![fixture]($path) after")), null)
    private fun answer(messages: List<RichMessage>) = messages.last { it.role == MessageRole.ASSISTANT }

    @Test fun genuineNativeCallResultAndDurableAssistantPermitOnlyExactAliases() {
        val messages = source(); val assistant = answer(messages)
        assertTrue(assistant.provenanceSeqs.isEmpty()); assertEquals(listOf(3L), assistant.sourceSeqs)
        val aliases = MarkdownImageAliases(messages)
        val binding = requireNotNull(aliases.resolve(assistant, path))
        assertEquals("fixture-opaque-image", binding.reference.attachmentId)
        assertEquals(binding, aliases.resolve(assistant, explicit)?.copy(destination = path))
        assertEquals(1L, binding.receipt.callSeq); assertEquals(2L, binding.receipt.resultSeq)
    }

    @Test fun basenameCanonicalizationUriAndPercentEncodingNeverCreateMatches() {
        val messages = source(); val aliases = MarkdownImageAliases(messages)
        for (destination in listOf("fixture.png", "images/fixture.png", "/other/fixture.png", "/synthetic/images/./fixture.png",
            "/synthetic/images/%66ixture.png", "file://$path", "https://example.invalid/fixture.png", "data:image/png;base64,AA==",
            "content://fixture", "javascript:fixture", "sandbox:$path", "ATTACHMENT:fixture-opaque-image", "attachment:unknown")) {
            assertNull(destination, aliases.resolve(answer(messages), destination))
        }
    }

    @Test fun liveSyntheticSequenceInterruptedAndEarlierProvenanceCannotUseAnAlias() {
        val messages = source(); val aliases = MarkdownImageAliases(messages); val assistant = answer(messages)
        assertNull(aliases.resolve(assistant.copy(streaming = true, sourceSeqs = emptyList(), seq = 900), path))
        assertNull(aliases.resolve(assistant.copy(sourceSeqs = emptyList()), path))
        assertNull(aliases.resolve(assistant.copy(interrupted = true), path))
        assertNull(aliases.resolve(assistant.copy(provenanceSeqs = listOf(1)), path))
        assertNull(aliases.resolve(assistant.copy(sourceSeqs = listOf(-1)), path))
    }

    @Test fun aLaterReceiptCannotLeakFromItsEarlierVisualCallPosition() {
        val messages = source(result = RichFixtures.result(10, content()), answerSeq = 5)
        val tool = messages.first { it.tool != null }
        assertEquals(1L, tool.seq); assertEquals(10L, tool.tool?.resultSeq)
        assertNull(MarkdownImageAliases(messages).resolve(answer(messages), path))
        assertNull(MarkdownImageAliases(messages).resolve(answer(messages), explicit))
    }

    @Test fun orphanPreviewAndMalformedOriginalArgumentsCannotMintReceipts() {
        for (raw in listOf("{\"file_path\":", """{"file_path":"$path","file_path":"/other.png"}""",
            """{"file_path":"$path","file\u005fpath":"/other.png"}""", """{"file_path":"$path","other":true}""",
            """{"file_path":null}""", "{}")) {
            val messages = source(call = RichFixtures.call(1, "read_image", raw))
            assertNull(raw, messages.first { it.tool != null }.tool?.nativeImageReceipt)
            assertNull(raw, MarkdownImageAliases(messages).resolve(answer(messages), explicit))
        }
        val orphan = RichTranscriptProjection.render(listOf(RichFixtures.result(2, content()), RichFixtures.assistant(3, "![x]($path)")), null)
        assertNull(MarkdownImageAliases(orphan).resolve(answer(orphan), explicit))
    }

    @Test fun timelineRestoredNameAndArgumentsAreNotOriginalDispatchProvenance() {
        val call = RichFixtures.call(1, "read_image", args)
        val missing = call.copy(data = JsonObject((call.data as JsonObject) - setOf("name", "arguments")))
        val preview = RichFixtures.event("assistant/message", 0, buildJsonObject {
            put("turn", 1); put("step", 0); put("message", buildJsonObject { put("content", buildJsonArray {
                add(buildJsonObject { put("type", "tool-call"); put("id", "fixture-call"); put("name", "read_image"); put("arguments", args) })
            }) })
        })
        val messages = RichTranscriptProjection.render(listOf(preview, missing, RichFixtures.result(2, content()), RichFixtures.assistant(3, "![x]($path)")), null)
        val tool = requireNotNull(messages.first { it.tool != null }.tool)
        assertEquals("read_image", tool.name); assertEquals(args, tool.argsRaw); assertNotNull(tool.callSeq)
        assertNull(tool.nativeImageReceipt)
        assertNull(MarkdownImageAliases(messages).resolve(answer(messages), path))
    }

    @Test fun errorTruncationOffloadMultipleImagesAndForgedTextOrJsonNeverBind() {
        val offloaded = JsonObject((RichFixtures.image as JsonObject) + ("offloaded" to JsonPrimitive(true)))
        val badResults = listOf(
            RichFixtures.result(2, content(), isError = true),
            RichFixtures.result(2, content(), meta = RichFixtures.json("""{"truncated":true}""")),
            RichFixtures.result(2, content(offloaded)),
            RichFixtures.result(2, buildJsonArray { add(RichFixtures.image); add(RichFixtures.image) }),
            RichFixtures.result(2, RichFixtures.content("""{"attachmentId":"fixture-opaque-image","path":"$path"}""")),
        )
        for (result in badResults) {
            val messages = source(result = result)
            assertNull(MarkdownImageAliases(messages).resolve(answer(messages), path))
            assertNull(MarkdownImageAliases(messages).resolve(answer(messages), explicit))
        }
    }

    @Test fun repeatedPathWithDifferentTypedReferencesIsAmbiguousButExactAttachmentIdsAreNot() {
        val other = JsonObject((RichFixtures.image as JsonObject) + ("attachment" to JsonObject(
            ((RichFixtures.image as JsonObject)["attachment"] as JsonObject) + ("attachmentId" to JsonPrimitive("second-image")))))
        val messages = RichTranscriptProjection.render(listOf(RichFixtures.call(1, "read_image", args), RichFixtures.result(2, content()),
            RichFixtures.call(3, "read_image", args, "second-call"), RichFixtures.result(4, content(other), "second-call"), RichFixtures.assistant(5, "![x]($path)")), null)
        val aliases = MarkdownImageAliases(messages)
        assertNull(aliases.resolve(answer(messages), path))
        assertNotNull(aliases.resolve(answer(messages), explicit))
        assertEquals("second-image", aliases.resolve(answer(messages), "attachment:second-image")?.reference?.attachmentId)
    }

    @Test fun changedOriginalArgumentsAndReceiptRemovalRevokeEvenAnOtherwiseKnownReference() {
        val messages = source(); val assistant = answer(messages); val toolMessage = messages.first { it.tool != null }
        val tool = requireNotNull(toolMessage.tool)
        val changed = messages.map { if (it === toolMessage) it.copy(tool = tool.copy(argsRaw = """{"file_path":"/changed.png"}""")) else it }
        assertNull(MarkdownImageAliases(changed).resolve(assistant, path))
        val noReceipt = messages.map { if (it === toolMessage) it.copy(tool = tool.copy(nativeImageReceipt = null)) else it }
        assertTrue(noReceipt.any { it.blocks.any { block -> block is RenderBlock.Image } })
        assertNull(MarkdownImageAliases(noReceipt).resolve(assistant, explicit))
    }

    @Test fun duplicateCallsWithdrawnCallsAndPartialHistoryFailClosed() {
        val duplicate = RichTranscriptProjection.render(listOf(RichFixtures.call(0, "read_image", args), RichFixtures.call(1, "read_image", args),
            RichFixtures.result(2, content()), RichFixtures.assistant(3, "![x]($path)")), null)
        assertNull(MarkdownImageAliases(duplicate).resolve(answer(duplicate), path))
        val replacement = RichFixtures.assistant(2, "replacement").copy(surfaceOp = RichFixtures.json("""{"op":"replace","startSeq":1,"endSeq":1}"""))
        val withdrawn = RichTranscriptProjection.render(listOf(RichFixtures.call(1, "read_image", args), replacement,
            RichFixtures.result(3, content()), RichFixtures.assistant(4, "![x]($path)")), null)
        assertNull(MarkdownImageAliases(withdrawn).resolve(answer(withdrawn), path))
        assertNull(MarkdownImageAliases(emptyList()).resolve(answer(source()), path))
    }

    @Test fun genericNativeImageReceiptSupportsExactAttachmentButNeverAPathAlias() {
        val messages = source(call = RichFixtures.call(1, "fixture_image_tool", "{}"))
        assertNotNull(MarkdownImageAliases(messages).resolve(answer(messages), explicit))
        assertNull(MarkdownImageAliases(messages).resolve(answer(messages), path))
    }

    @Test fun invalidCallResultIdentityAndOrderingCannotConfirmAnAssociation() {
        val messages = source(); val result = requireNotNull(messages.first { it.tool != null }.tool)
        val original = result.copy(phase = ToolPhase.RUNNING, content = emptyList(), resultSeq = null, nativeImageReceipt = null)
        for (invalid in listOf(result.copy(callId = "other-call"), result.copy(callSeq = 9), result.copy(resultSeq = 1), result.copy(resultSeq = -1))) {
            assertNull(NativeImageReceipts.confirm(original, invalid))
        }
        assertNull(NativeImageReceipts.confirm(original.copy(callSeq = -1), result))
        val mismatched = source(result = RichFixtures.result(2, content(), id = "other-call"))
        assertNull(MarkdownImageAliases(mismatched).resolve(answer(mismatched), explicit))
    }

    @Test fun changedTypedReferenceMetadataInvalidatesReceiptEvenIfIdIsUnchanged() {
        val messages = source(); val assistant = answer(messages)
        val changed = messages.map { message -> message.tool?.let { tool ->
            val altered = tool.content.map { if (it is RenderBlock.Image) it.copy(reference = it.reference.copy(width = 99)) else it }
            message.copy(blocks = altered, tool = tool.copy(content = altered))
        } ?: message }
        assertNull(MarkdownImageAliases(changed).resolve(assistant, explicit))
    }

    @Test fun tooManyReceiptsDisableAliasesRatherThanHidePotentialAmbiguity() {
        val messages = source(); val tool = messages.first { it.tool != null }
        val overflow = (0..MarkdownImageAliases.MAX_RECEIPTS).map { tool.copy(stableId = "synthetic-duplicate-source:$it") }
        assertNull(MarkdownImageAliases(overflow).resolve(answer(messages), path))
        assertNull(MarkdownImageAliases(overflow).resolve(answer(messages), explicit))
    }
}
