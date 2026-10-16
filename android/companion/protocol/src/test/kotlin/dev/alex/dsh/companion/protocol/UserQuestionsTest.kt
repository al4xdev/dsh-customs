package dev.alex.dsh.companion.protocol

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class UserQuestionsTest {
    private fun obj(text: String) = NativeCodec.json(text).objectValue()
    private fun request(text: String = """{"questions":[{"id":"q","question":"Synthetic choice?","options":[{"label":"Yes","description":"Synthetic detail"},{"label":"No"}]}]}""") = UserQuestionCodec.requestText(text)
    private fun fails(block: () -> Unit) { assertThrows(ProtocolException::class.java, block) }
    private fun key(kind: UserQuestionKind = UserQuestionKind.LEGACY_BLOCKING) = UserQuestionKey(1, "source", "client", "event", "chat", if (kind == UserQuestionKind.LEGACY_BLOCKING) null else "call", kind, "digest", 1)

    /** Captured from an actual isolated SDK Gateway/AgentLoop/UserQuestionService, not hand-written wire. */
    private fun golden(name: String): String = requireNotNull(javaClass.getResourceAsStream("/user-questions-sdk/$name.json")).bufferedReader().use { it.readText() }

    @Test fun actualSdkRequestAndOpenContinuedSettledGoldenValuesDecodeWithoutChangingWireShape() {
        val request = UserQuestionCodec.requestText(golden("timed-request"))
        assertEquals(UserQuestionWait("call-fixture-timed", true), request.wait)
        val open = UserQuestionCodec.projectionText(golden("open"))
        val continued = UserQuestionCodec.projectionText(golden("continued"))
        assertEquals(request.questions, open.active.single().questions)
        assertEquals(UserQuestionState.OPEN, open.active.single().state)
        assertEquals(UserQuestionState.CONTINUED, continued.active.single().state)
        assertEquals(open.active.single().questions, continued.active.single().questions)
        val settled = UserQuestionCodec.projectionText(golden("settled"))
        assertTrue(settled.active.isEmpty())
        assertEquals("call-fixture-timed", settled.settled.single().callId)
        assertEquals(UserQuestionAnswer(listOf(UserQuestionAnswerItem("choice", listOf("Alpha")))), settled.settled.single().answers)
    }
    @Test fun settledWireAnswersIsArrayAndNeverNestedBatchEnvelope() {
        val wire = obj(golden("settled"))
        assertTrue(wire.getValue("settled").arrayValue().single().objectValue().getValue("answers") is JsonArray)
        fails { UserQuestionCodec.projectionText("""{"active":[],"settled":[{"callId":"c","answers":{"answers":[{"id":"q","selected":["A"]}]}}]}""") }
    }
    @Test fun sdkSelectedFieldRemainsRequiredEvenForCustomOnlyAnswer() {
        val custom = UserQuestionCodec.answerText("""{"answers":[{"id":"q","selected":[],"custom":"Synthetic free text"}]}""")
        assertEquals(emptyList<String>(), custom.answers.single().selected)
        assertEquals("Synthetic free text", custom.answers.single().custom)
        fails { UserQuestionCodec.answerText("""{"answers":[{"id":"q","custom":"Synthetic free text"}]}""") }
        fails { UserQuestionCodec.answerText("""{"answers":[{"id":"q","selected":null,"custom":"Synthetic free text"}]}""") }
    }
    @Test fun androidCanonicalValidationRejectsLabelsAndCardinalityThatActualSdkServiceAccepts() {
        val questions = UserQuestionCodec.requestText(golden("timed-request")).questions
        fails { UserQuestionCodec.validateAnswer(questions, UserQuestionAnswer(listOf(UserQuestionAnswerItem("choice", listOf("NOT_A_DECLARED_LABEL", "Alpha"))))) }
        fails { UserQuestionCodec.validateAnswer(questions, UserQuestionAnswer(listOf(UserQuestionAnswerItem("choice", listOf("Alpha", "Beta"))))) }
        assertEquals(listOf("Alpha"), UserQuestionCodec.validateAnswer(questions, UserQuestionAnswer(listOf(UserQuestionAnswerItem("choice", listOf("Alpha"))))).answers.single().selected)
    }

    @Test fun canonicalServiceRequestDoesNotUseModelArgumentSpelling() {
        val parsed = request("""{"questions":[{"id":"q","question":"Pick","header":"Synthetic","detail":"literal **detail**","multiSelect":true,"options":[{"label":"A"}]}],"wait":{"callId":"call","timed":true}}""")
        assertTrue(parsed.questions.single().multiSelect)
        assertEquals(UserQuestionWait("call", true), parsed.wait)
        fails { request("""{"questions":[{"id":"q","question":"Pick","multi_select":true}]}""") }
    }
    @Test fun singleMultiFreeAndMultipleQuestionsValidateInQuestionOrder() {
        val questions = request("""{"questions":[{"id":"single","question":"Single","options":[{"label":"A"},{"label":"B"}]},{"id":"multi","question":"Multi","multiSelect":true,"options":[{"label":"A"},{"label":"B"}]},{"id":"free","question":"Free"}]}""").questions
        val answer = UserQuestionCodec.answerText("""{"answers":[{"id":"free","selected":[],"custom":"Synthetic literal"},{"id":"multi","selected":["B","A"],"custom":"Also synthetic"},{"id":"single","selected":["A"]}]}""")
        assertEquals(listOf("single", "multi", "free"), UserQuestionCodec.validateAnswer(questions, answer).answers.map { it.id })
        assertFalse(answer.toString().contains("Synthetic literal"))
    }
    @Test fun noImplicitDefaultAnswerOrSelectionByPosition() {
        val questions = request().questions
        fails { UserQuestionCodec.validateAnswer(questions, UserQuestionAnswer(emptyList())) }
        fails { UserQuestionCodec.validateAnswer(questions, UserQuestionAnswer(listOf(UserQuestionAnswerItem("q", emptyList())))) }
        fails { UserQuestionCodec.validateAnswer(questions, UserQuestionAnswer(listOf(UserQuestionAnswerItem("q", listOf("0"))))) }
        fails { UserQuestionCodec.validateAnswer(questions, UserQuestionAnswer(listOf(UserQuestionAnswerItem("q", listOf("Yes", "No"))))) }
        fails { UserQuestionCodec.validateAnswer(questions, UserQuestionAnswer(listOf(UserQuestionAnswerItem("q", listOf("Yes"), "Other")))) }
        fails { UserQuestionCodec.validateAnswer(questions, UserQuestionAnswer(listOf(UserQuestionAnswerItem("q", emptyList(), "  ")))) }
        assertEquals("Other", UserQuestionCodec.validateAnswer(questions, UserQuestionAnswer(listOf(UserQuestionAnswerItem("q", emptyList(), "Other")))).answers.single().custom)
    }
    @Test fun duplicateKeysIdsLabelsAndAnswerIdsAreRejected() {
        fails { request("""{"questions":[],"questions":[{"id":"q","question":"Q"}]}""") }
        fails { request("""{"questions":[{"id":"q","question":"Q","question":"Replacement"}]}""") }
        fails { request("""{"questions":[{"id":"q","question":"Q"},{"id":"q","question":"Other"}]}""") }
        fails { request("""{"questions":[{"id":"q","question":"Q","options":[{"label":"A"},{"label":"A"}]}]}""") }
        fails { UserQuestionCodec.answerText("""{"answers":[{"id":"q","selected":[]},{"id":"q","selected":[]}]}""") }
        fails { UserQuestionCodec.answerText("""{"answers":[{"id":"q","selected":["A","A"]}]}""") }
        fails { UserQuestionCodec.answerText("""{"answers":[{"id":"q","selected":[],"custom":"a","custom":"b"}]}""") }
    }
    @Test fun planIntentNamesApprovingOptionAndUnknownIntentRemainsLiteral() {
        val plan = request("""{"questions":[{"id":"q","question":"Review","detail":"Synthetic markdown","options":[{"label":"Decline"},{"label":"Approve"}],"intent":{"kind":"plan-review","approve":"Approve","callId":"plan-call"}}]}""").questions.single()
        assertEquals("Approve", plan.intent?.get("approve")?.stringValue())
        fails { request("""{"questions":[{"id":"q","question":"Review","detail":"detail","options":[{"label":"A"}],"intent":{"kind":"plan-review","approve":"Absent"}}]}""") }
        fails { request("""{"questions":[{"id":"q","question":"Review","options":[{"label":"A"}],"intent":{"kind":"plan-review","approve":"A"}}]}""") }
        val unknown = request("""{"questions":[{"id":"q","question":"Q","intent":{"kind":"future","extra":{"opaque":true}}}]}""").questions.single()
        assertTrue(unknown.intent?.containsKey("extra") == true)
    }
    @Test fun budgetsNullWrongTypesAndBlankValuesFailClosed() {
        fails { request("""{"questions":[]}""") }
        fails { request("""{"questions":[{"id":" ","question":"Q"}]}""") }
        fails { request("""{"questions":[{"id":"q","question":"Q","multiSelect":"true"}]}""") }
        fails { request("""{"questions":[{"id":"q","question":"Q","options":null}]}""") }
        fails { request("""{"questions":[{"id":"q","question":"Q"}],"wait":{"callId":"c","timed":null}}""") }
        fails { UserQuestionCodec.questions(UserQuestionCodec.questionsJson(List(33) { UserQuestionItem("q$it", "Q") })) }
        fails { UserQuestionCodec.questions(UserQuestionCodec.questionsJson(listOf(UserQuestionItem("q", "Q", options = List(65) { UserQuestionOption("$it") })))) }
        fails { UserQuestionCodec.validateAnswer(request().questions, UserQuestionAnswer(listOf(UserQuestionAnswerItem("q", emptyList(), "x".repeat(UserQuestionLimits.TEXT + 1))))) }
    }
    @Test fun digestCoversEveryQuestionPresentationField() {
        val original = request().questions
        val digest = UserQuestionCodec.digest(original)
        assertEquals(64, digest.length)
        assertEquals(digest, UserQuestionCodec.digest(UserQuestionCodec.questions(UserQuestionCodec.questionsJson(original))))
        assertNotEquals(digest, UserQuestionCodec.digest(original.map { it.copy(detail = "new") }))
        assertNotEquals(digest, UserQuestionCodec.digest(original.map { it.copy(multiSelect = true) }))
        assertNotEquals(digest, UserQuestionCodec.digest(original.map { it.copy(options = it.options.reversed()) }))
    }
    @Test fun projectionSeparatesOpenContinuedSettledAndRejectsOverlap() {
        val parsed = UserQuestionCodec.projectionText("""{"active":[{"callId":"c1","questions":[{"id":"q","question":"Q"}],"state":"open"},{"callId":"c2","questions":[{"id":"q","question":"Q"}],"state":"continued"}],"settled":[{"callId":"c3","answers":[]}]}""")
        assertEquals(listOf(UserQuestionState.OPEN, UserQuestionState.CONTINUED), parsed.active.map { it.state })
        assertTrue(parsed.settled.single().answers.answers.isEmpty())
        fails { UserQuestionCodec.projectionText("""{"active":[{"callId":"c","questions":[{"id":"q","question":"Q"}],"state":"completed"}],"settled":[]}""") }
        fails { UserQuestionCodec.projectionText("""{"active":[{"callId":"c","questions":[{"id":"q","question":"Q"}],"state":"open"}],"settled":[{"callId":"c","answers":[]}]}""") }
    }
    @Test fun exactSdkEventResultContinuedAnswerAndTimedClaimWirePaths() {
        val answer = UserQuestionOutcome.Answer(UserQuestionAnswer(listOf(UserQuestionAnswerItem("q", listOf("Yes")))))
        val event = obj(UserQuestionRequests.eventResult("r", UserQuestionSubmission(key(), answer)))
        assertEquals("\$events/result", event.getValue("method").stringValue())
        val args = event.getValue("payload").objectValue().getValue("args").objectValue()
        assertEquals(setOf("clientId", "eventId", "outcome"), args.keys)
        val outcome = args.getValue("outcome").objectValue()
        assertEquals("result", outcome.getValue("kind").stringValue())
        assertEquals("Yes", outcome.getValue("value").objectValue().getValue("answers").arrayValue()[0].objectValue().getValue("selected").arrayValue()[0].stringValue())
        val continued = obj(UserQuestionRequests.continuedAnswer("r", UserQuestionSubmission(key(UserQuestionKind.CONTINUED), answer)))
        assertEquals("userQuestions/answer", continued.getValue("method").stringValue())
        assertEquals(setOf("agentId", "callId", "answer"), continued.getValue("payload").objectValue().getValue("args").objectValue().keys)
        val timed = obj(UserQuestionRequests.attachWait("stream", UserQuestionAttachment(key(UserQuestionKind.TIMED_OPEN), 2)))
        assertEquals("userQuestions/attachWait", timed.getValue("endpoint").stringValue())
        assertEquals(setOf("agentId", "callId"), timed.getValue("payload").objectValue().getValue("args").objectValue().keys)
        val timeout = obj(UserQuestionRequests.eventResult("r", UserQuestionSubmission(key(UserQuestionKind.TIMED_OPEN), UserQuestionOutcome.TimedOut)))
        assertEquals("ASK_TIMED_OUT", timeout.getValue("payload").objectValue().getValue("args").objectValue().getValue("outcome").objectValue().getValue("error").objectValue().getValue("code").stringValue())
        fails { UserQuestionRequests.eventResult("r", UserQuestionSubmission(key(), UserQuestionOutcome.TimedOut)) }
        fails { UserQuestionRequests.continuedAnswer("r", UserQuestionSubmission(key(), answer)) }
        fails { UserQuestionRequests.eventResult("r", UserQuestionSubmission(key(UserQuestionKind.CONTINUED), answer)) }
    }
    @Test fun hostRemainingFrameIsBoundedAndHasNoClientDeadline() {
        assertEquals(123L, UserQuestionCodec.remaining(obj("""{"remainingMs":123}""")))
        fails { UserQuestionCodec.remaining(obj("""{"remainingMs":-1}""")) }
        fails { UserQuestionCodec.remaining(obj("""{"remainingMs":2147483648}""")) }
        fails { UserQuestionCodec.remaining(obj("""{"remainingMs":10,"deadline":100}""")) }
    }
}
