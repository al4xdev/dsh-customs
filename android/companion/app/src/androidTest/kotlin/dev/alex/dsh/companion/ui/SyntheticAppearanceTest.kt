package dev.alex.dsh.companion.ui

import android.graphics.Bitmap
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.dp
import androidx.test.platform.app.InstrumentationRegistry
import dev.alex.dsh.companion.render.*
import dev.alex.dsh.companion.protocol.ApprovalDecision
import dev.alex.dsh.companion.protocol.ApprovalKey
import dev.alex.dsh.companion.protocol.CompanionChat
import dev.alex.dsh.companion.protocol.NativeActivation
import dev.alex.dsh.companion.protocol.NativeActivity
import dev.alex.dsh.companion.protocol.NativeGoal
import dev.alex.dsh.companion.protocol.NativeGoalControl
import dev.alex.dsh.companion.protocol.NativeGoalPhase
import dev.alex.dsh.companion.protocol.NativeGoalsState
import dev.alex.dsh.companion.protocol.NativeKnowledge
import dev.alex.dsh.companion.protocol.NativeTodo
import dev.alex.dsh.companion.protocol.NativeTodoStatus
import dev.alex.dsh.companion.notifications.PushUiStatus
import dev.alex.dsh.companion.ui.settings.*
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/** Local-only visual evidence. Every word/ID/result here is authored synthetic content. */
class SyntheticAppearanceTest {
    @get:Rule val ui = createComposeRule()
    private val actions = object : UiActions {
        override fun login(link: String) = Unit
        override fun restoreLogin() = Unit
        override fun logout() = Unit
        override fun refresh() = Unit
        override fun create() = Unit
        override fun select(id: String) = Unit
        override fun back() = Unit
        override fun draft(text: String) = Unit
        override fun send() = Unit
        override fun loadMore() = Unit
        override fun reconnect() = Unit
        override fun decide(key: ApprovalKey, decision: ApprovalDecision) = Unit
        override fun cancelTurn() = Unit
    }
    private fun prose(seq: Long, role: MessageRole, text: String) = RichMessage(seq, role, text, listOf(RenderBlock.Text(text)), stableId = "visual:$seq")
    private fun screenshot(name: String, includePopup: Boolean = false) {
        ui.waitForIdle()
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        // DropdownMenu is a second Android window; a Compose root capture cannot include both.
        val bitmap = if (includePopup) requireNotNull(instrumentation.uiAutomation.takeScreenshot())
            else ui.onRoot().captureToImage().asAndroidBitmap()
        val directory = requireNotNull(instrumentation.targetContext.externalCacheDir)
        File(directory, name).outputStream().use { assertTrue(bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)) }
    }

    @Test fun amoledDocumentHasContinuousTwoColumnTableAndRoundedComposer() {
        val text = """
            ## Um documento, sem distrações

            O fundo é preto. A tabela mantém as linhas juntas, sem reduzir o tamanho do texto.

            | Bloco | Apresentação |
            | --- | --- |
            | Texto | Seleção nativa |
            | Tabela | Um grupo contínuo |
            | Imagem | Recibo confirmado |

            > Só o conteúdo importa. Os controles ficam no compositor.
        """.trimIndent()
        val state = CompanionUiState(authenticated = true, connected = true, selectedId = "visual-amoled",
            title = "Contexto acessível, não um cabeçalho", draft = "Vamos continuar.",
            richMessages = listOf(prose(0, MessageRole.USER, "Como ficou a nova interface?"), prose(1, MessageRole.ASSISTANT, text)))
        ui.setContent { CompanionTheme { Surface(Modifier.fillMaxSize(), color = Color.Black) { CompanionScreen(state, actions) } } }
        ui.waitUntil(8_000) { ui.onAllNodesWithText("Um grupo contínuo").fetchSemanticsNodes().size == 1 }
        ui.onNodeWithText("Um grupo contínuo").assertIsDisplayed()
        ui.onNodeWithContentDescription("Voltar").assertDoesNotExist()
        ui.onNodeWithText(state.title).assertDoesNotExist()
        screenshot("task95-amoled-table-composer.png")
    }

    @Test fun amoledCatalogOffersDeleteOnlyAfterLongPress() {
        val chats = listOf(CompanionChat("visual-card-1", "Revisão do projeto", 1, null),
            CompanionChat("visual-card-2", "Notas da conversa", 2, null),
            CompanionChat("visual-card-3", "Resultados e anexos", 3, null))
        ui.setContent { CompanionTheme { Surface(Modifier.fillMaxSize(), color = Color.Black) {
            CompanionScreen(CompanionUiState(authenticated = true, connected = true, chats = chats), actions)
        } } }
        ui.onNodeWithText("Apagar conversa").assertDoesNotExist()
        screenshot("task95-amoled-catalog.png")
        ui.onNodeWithTag("conversation-card:visual-card-1").performTouchInput { longClick() }
        ui.onNodeWithText("Apagar conversa").assertIsDisplayed()
        val pressed = ui.onNodeWithTag("conversation-card:visual-card-1").captureToImage().toPixelMap()
        // The external combined-click ripple must not paint a square over rounded card corners.
        listOf(0 to 0, (pressed.width - 1) to 0, 0 to (pressed.height - 1),
            (pressed.width - 1) to (pressed.height - 1)).forEach { (x, y) -> assertEquals(Color.Black, pressed[x, y]) }
        screenshot("task95-amoled-catalog-longpress.png", includePopup = true)
    }

    @Test fun polishedComposerUsesTheLowerViewportForSixLines() {
        val draft = (1..6).joinToString("\n") { "Linha sintética $it" }
        val state = CompanionUiState(authenticated = true, connected = true, selectedId = "visual-composer95",
            title = "Contexto acessível", draft = draft,
            richMessages = listOf(prose(0, MessageRole.ASSISTANT, "O botão fica no canto; o texto aproveita a altura.")))
        ui.setContent { CompanionTheme { Surface(Modifier.fillMaxSize(), color = Color.Black) { CompanionScreen(state, actions) } } }
        ui.onNodeWithTag("message-input").assertIsDisplayed()
        val input = ui.onNodeWithTag("message-input").fetchSemanticsNode().boundsInRoot
        val send = ui.onNodeWithContentDescription("Enviar").fetchSemanticsNode().boundsInRoot
        assertTrue(input.bottom > send.top)
        assertTrue(input.right <= send.left)
        screenshot("task95-composer-six-lines.png")
    }

    @Test fun compactToolsStayVisuallySeparateFromHumanMessages() {
        val messages = listOf(
            prose(0, MessageRole.USER, "Pode revisar o contexto e o arquivo de teste?"),
            RichMessage(1, MessageRole.TOOL, "", emptyList(), ToolPresentation("synthetic-long-internal-call-id-not-a-chat-heading", "session", ToolPhase.OK,
                "{\"operation\":\"inspect\",\"id\":\"visual-fixture\",\"view\":\"head\"}", content = listOf(RenderBlock.Text("2 mensagens originais de contexto. Somente leitura."))), stableId = "tool:visual-inspect"),
            RichMessage(2, MessageRole.TOOL, "", emptyList(), ToolPresentation("synthetic-read-call", "read", ToolPhase.OK,
                "{\"file_path\":\"/workspace/relatorio-de-teste.md\",\"offset\":1,\"limit\":2}",
                detail = ToolDetail.Read("/workspace/relatorio-de-teste.md", 1, listOf(NumberedLine(1, "# Relatório sintético"), NumberedLine(2, "Contexto conferido.")), 2, "markdown", false)), stableId = "tool:visual-read"),
            prose(3, MessageRole.ASSISTANT, "Conferi o início da conversa e o arquivo. As ferramentas ficam na trilha compacta; esta é a resposta para você."),
        )
        ui.setContent { CompanionTheme { CompanionScreen(CompanionUiState(authenticated = true, connected = true, selectedId = "visual-fixture", title = "Teste visual · dados sintéticos", richMessages = messages), actions) } }
        ui.waitForIdle()
        ui.onNodeWithContentDescription("Expandir atividade").assertIsDisplayed()
        ui.onNodeWithText("session", substring = true).assertDoesNotExist()
        ui.onNodeWithText("DSH").assertDoesNotExist()
        val human = ui.onNodeWithTag("human-bubble:visual:0").getUnclippedBoundsInRoot()
        val assistant = ui.onNodeWithTag("transcript-cell:visual:3").getUnclippedBoundsInRoot()
        assertTrue("Only the human bubble is inset toward the right", human.left > assistant.left)
        ui.onNodeWithText("synthetic-long-internal-call-id-not-a-chat-heading").assertDoesNotExist()
        screenshot("visual-tool-timeline.png")
        ui.onNodeWithContentDescription("Expandir atividade").performClick()
        ui.onNodeWithText("session · inspect").assertIsDisplayed()
        ui.onNodeWithText("read").assertIsDisplayed()
        ui.onNodeWithText("Contexto conferido.").assertDoesNotExist()
        screenshot("visual-activity-expanded.png")
    }

    @Test fun tallFinalMessageHasPositiveBreathingRoomBeforeComposer() {
        val text = (1..36).joinToString("\n") { "Linha $it do histórico sintético, sem dados reais." } + "\nFINAL SINTÉTICO"
        ui.setContent { CompanionTheme { CompanionScreen(CompanionUiState(authenticated = true, connected = true, selectedId = "visual-fixture", title = "Teste visual · fim do histórico", richMessages = listOf(prose(0, MessageRole.ASSISTANT, text))), actions) } }
        ui.waitForIdle()
        val message = ui.onNodeWithText("FINAL SINTÉTICO", substring = true).assertIsDisplayed().getUnclippedBoundsInRoot()
        val composer = ui.onNode(hasSetTextAction()).getUnclippedBoundsInRoot()
        assertTrue("Synthetic transcript/composer gap must remain positive", composer.top - message.bottom >= 20.dp)
        screenshot("visual-chat-bottom.png")
    }

    @Test fun formattedStreamingGrowthKeepsLastParagraphAboveComposer() {
        var source = (1..24).joinToString("\n") { "Linha sintética $it do texto em andamento." }
        fun publication(text: String) = CompanionUiState(authenticated = true, connected = true,
            selectedId = "visual-fixture", title = "Teste visual · streaming",
            response = dev.alex.dsh.companion.delivery.ResponseActivityState(
                dev.alex.dsh.companion.delivery.ResponsePhase.STREAMING, "synthetic-turn", false, emptySet()),
            richMessages = listOf(prose(0, MessageRole.ASSISTANT, text).copy(streaming = true, turn = 1)))
        val state = androidx.compose.runtime.mutableStateOf(publication(source))
        ui.setContent { CompanionTheme { CompanionScreen(state.value, actions) } }
        for (step in 1..8) {
            val marker = "MARCADOR SINTÉTICO $step"
            source += "\n\n**Bloco formatado $step**\n\n$marker"
            ui.runOnIdle { state.value = publication(source) }
            // Waiting for a parsed paragraph also covers the worker's later geometry update,
            // not just the first literal tail that was drawn when the delta arrived.
            ui.waitUntil(5_000) { ui.onAllNodesWithText(marker).fetchSemanticsNodes().size == 1 }
            ui.waitForIdle()
            val tail = ui.onNodeWithText(marker).assertIsDisplayed().getUnclippedBoundsInRoot()
            val composer = ui.onNode(hasSetTextAction()).getUnclippedBoundsInRoot()
            assertTrue("Formatted streaming tail must not disappear under composer", composer.top - tail.bottom >= 20.dp)
        }
    }

    @Test fun settingsContainsExplicitModelScopeAndLogout() {
        val fixture = SettingsUiState(defaultModel = SettingsModelChoice("synthetic-provider", "fixture-model", "low"),
            models = listOf(SettingsModelOption("synthetic-provider", "Provedor de teste", "fixture-model", "Modelo de teste",
                efforts = listOf(SettingsReasoningEffort("low", "Baixo")))), canSelectDefault = true)
        ui.setContent { CompanionTheme { CompanionScreen(CompanionUiState(authenticated = true, settings = fixture), actions) } }
        ui.onNodeWithContentDescription("Configurações").performClick()
        ui.waitForIdle()
        ui.onNodeWithText("Sair").assertExists()
        screenshot("visual-settings.png")
    }

    @Test fun nativeGoalExpandsTheFloatingComposerWithPinnedHumanControls() {
        val sid = "visual-goals-only-fixture"
        val native = NativeGoalsState(knowledge = NativeKnowledge.CURRENT, sessionId = sid,
            goal = NativeGoal("visual-native-goal", 3, "Preparar a próxima versão", NativeGoalPhase.ACTIVE, 8, 2, NativeActivation.ARMED),
            control = NativeGoalControl(sid, "visual-native-goal", 3, "visual-source", "visual-incarnation", 1, "visual-control"),
            todos = listOf(NativeTodo("Revisar os estados nativos", NativeTodoStatus.COMPLETED),
                NativeTodo("Validar o compositor e os controles", NativeTodoStatus.IN_PROGRESS),
                NativeTodo("Gerar o APK de amanhã", NativeTodoStatus.PENDING)))
        val state = CompanionUiState(authenticated = true, connected = true, selectedId = sid, nativeGoals = native,
            draft = "Continua de onde parou.", richMessages = listOf(prose(0, MessageRole.ASSISTANT,
                "O goal e a lista da rodada ficam recolhidos no compositor. Pausar o goal usa o controle nativo, não envia uma mensagem.")))
        ui.setContent { CompanionTheme { CompanionScreen(state, actions) } }
        // Inspect both interaction frames from the Android window rather than
        // mixing repeated per-node RenderNode captures with subsequent drawing.
        screenshot("task101-goal-composer-collapsed.png", includePopup = true)
        ui.onNodeWithTag("toggle-native-goals").performClick()
        ui.onNodeWithTag("pause-native-goal").assertIsDisplayed().assertIsEnabled()
        ui.onNodeWithTag("resume-native-goal").assertIsDisplayed().assertIsNotEnabled()
        val panel = ui.onNodeWithTag("goal-panel").getUnclippedBoundsInRoot()
        val input = ui.onNodeWithTag("message-input").getUnclippedBoundsInRoot()
        assertTrue("Goal panel expands above, not over the draft", panel.bottom <= input.top)
        ui.onNodeWithText("Continua de onde parou.").assertIsDisplayed()
        screenshot("task101-goal-composer-expanded.png", includePopup = true)
    }

    @Test fun nativeCatalogHasTwoDistinctSignalsAndNeverGuessesUnknownActivity() {
        val chats = listOf(CompanionChat("visual-native-both", "Preparando a próxima versão", 1, null),
            CompanionChat("visual-native-reply", "Uma resposta em andamento", 2, null),
            CompanionChat("visual-native-unknown", "Histórico sem atividade confirmada", 3, null))
        val state = CompanionUiState(authenticated = true, chats = chats, chatActivity = mapOf(
            "visual-native-both" to NativeActivity(NativeKnowledge.CURRENT, true, true),
            "visual-native-reply" to NativeActivity(NativeKnowledge.CURRENT, false, true),
            "visual-native-unknown" to NativeActivity(NativeKnowledge.UNKNOWN, null, null)))
        ui.setContent { CompanionTheme { CompanionScreen(state, actions) } }
        ui.onNodeWithTag("chat-goal-indicator:visual-native-both", useUnmergedTree = true).assertIsDisplayed()
        ui.onNodeWithTag("chat-response-indicator:visual-native-both", useUnmergedTree = true).assertIsDisplayed()
        ui.onNodeWithTag("chat-goal-indicator:visual-native-unknown", useUnmergedTree = true).assertDoesNotExist()
        screenshot("task101-catalog-native-activity.png")
    }

    @Test fun internalGoalRoundsLeaveOnlyHumanAndAssistantContentBesideTheGoalPanel() {
        val sid = "visual-native-fixed"
        val internal = "<goal_round>Internal continuation must stay outside the chat</goal_round>"
        fun event(type: String, seq: Long, data: String) = dev.alex.dsh.companion.protocol.SessionEvent(
            type, seq, 1, dev.alex.dsh.companion.protocol.NativeCodec.json(data), false, null, null)
        val messages = RichTranscriptProjection.render(listOf(
            event("user/message", 0, """{"content":[{"type":"text","text":"Podemos continuar por aqui."}]}"""),
            event("user/message", 1, """{"source":{"kind":"goal","goalId":"visual-goal","revision":3,"round":140},"content":[{"type":"text","text":"$internal"}]}"""),
            event("assistant/message", 2, """{"turn":1,"step":0,"message":{"content":[{"type":"text","text":"O andamento fica no painel, sem repetir instruções internas no chat."}]}}""")), null)
        assertEquals(2, messages.size)
        val native = NativeGoalsState(knowledge = NativeKnowledge.CURRENT, sessionId = sid,
            goal = NativeGoal("visual-goal", 3, "Acompanhar o teste do goal", NativeGoalPhase.ACTIVE, 256, 140, NativeActivation.ARMED),
            control = NativeGoalControl(sid, "visual-goal", 3, "visual-source", "visual-incarnation", 1, "visual-control"))
        ui.setContent { CompanionTheme { CompanionScreen(CompanionUiState(authenticated = true, connected = true,
            selectedId = sid, nativeGoals = native, richMessages = messages), actions) } }
        ui.onNodeWithTag("toggle-native-goals").performClick()
        ui.onNodeWithText("Contexto · goal").assertDoesNotExist()
        ui.onNodeWithText(internal).assertDoesNotExist()
        ui.onNodeWithText("Podemos continuar por aqui.").assertIsDisplayed()
        ui.onNodeWithTag("pause-native-goal").assertIsEnabled()
        screenshot("task104-goal-clean-chat.png", includePopup = true)
    }

    @Test fun notificationSettingsExplicitlyShowDeferredPushConfiguration() {
        ui.setContent { CompanionTheme { CompanionScreen(CompanionUiState(authenticated = true), actions,
            pushStatus = PushUiStatus()) } }
        ui.onNodeWithContentDescription("Configurações").performClick()
        ui.onNodeWithText("Push aguardando configuração").assertIsDisplayed()
        ui.onNodeWithText("Push pronto").assertDoesNotExist()
        screenshot("task101-notifications-unconfigured.png")
    }
}
