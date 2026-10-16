package dev.alex.dsh.companion.ui

import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.espresso.Espresso
import androidx.test.platform.app.InstrumentationRegistry
import android.graphics.Bitmap
import android.os.Handler
import android.os.Looper
import android.view.PixelCopy
import android.view.Window
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import dev.alex.dsh.companion.protocol.ApprovalDecision
import dev.alex.dsh.companion.protocol.ApprovalKey
import dev.alex.dsh.companion.protocol.CompanionChat
import dev.alex.dsh.companion.protocol.NativeCodec
import dev.alex.dsh.companion.protocol.SessionEvent
import dev.alex.dsh.companion.render.RichTranscriptProjection
import dev.alex.dsh.companion.ui.settings.ModelContextSetting
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class DisplayAndDraftTest {
    @get:Rule val ui = createComposeRule()

    @Test fun debugSwitchIsOffByDefaultAndItsHumanActionChangesOnlyPresentation() {
        val visible = mutableStateOf(false)
        val calls = mutableListOf<Boolean>()
        ui.setContent { CompanionTheme { ModelContextSetting(visible.value) { visible.value = it; calls += it } } }
        ui.onNodeWithTag("settings-model-context").assertIsOff().performClick().assertIsOn()
        ui.onNodeWithTag("settings-model-context").performClick().assertIsOff()
        ui.runOnIdle { assertEquals(listOf(true, false), calls) }
    }

    @Test fun localDraftRendersWithoutASessionIdOrNativeControlAndCanReturnToCatalog() {
        val current = mutableStateOf(CompanionUiState(authenticated = true, isNewDraft = true,
            title = "Nova conversa", draft = "Texto ainda local", chats = listOf(
                CompanionChat("fixture-existing", "Conversa existente", 1, null))))
        var backs = 0
        var sends = 0
        val actions = object : InertActions() {
            override fun send() { sends++ }
            override fun back() { backs++; current.value = current.value.copy(isNewDraft = false, draft = "") }
        }
        ui.setContent { CompanionTheme { CompanionScreen(current.value, actions) } }
        ui.onNodeWithTag("message-input").assertIsDisplayed()
        ui.onNodeWithTag("toggle-native-goals").assertDoesNotExist()
        ui.onNodeWithText("Conexão interrompida").assertDoesNotExist()
        ui.onNodeWithContentDescription("Enviar").assertIsEnabled()
        ui.runOnIdle { assertNull(current.value.selectedId); assertEquals(0, sends) }
        screenshot("task106-local-draft.png")
        Espresso.pressBack()
        ui.waitUntil(5000) { backs == 1 }
        ui.runOnIdle {
            assertFalse(current.value.hasOpenConversation)
            assertEquals(listOf("fixture-existing"), current.value.chats.map { it.id })
            assertEquals(0, sends)
        }
    }

    @Test fun changingDebugVisibilityShowsModelContextButNeverShowsAutomaticGoalInstructions() {
        val visible = mutableStateOf(false)
        val context = "Contexto sintético do modelo para depuração."
        val instructions = "Instruções sintéticas do AGENTS.md para o modelo."
        val delta = "Atualização sintética das instruções."
        val skills = "Catálogo sintético de skills para o modelo."
        val human = "Minha mensagem continua visível."
        val goalPrompt = "INTERNAL GOAL CONTINUATION FIXTURE"
        fun event(type: String, seq: Long, json: String) = SessionEvent(type, seq, 1, NativeCodec.json(json), false, null, null)
        val records = listOf(
            event("system/message", 0, """{"message":{"role":"system","source":{"kind":"system-prompt"},"content":[{"type":"text","text":"$context"}]}}"""),
            event("user/message", 1, """{"role":"user","source":{"kind":"user","rpcId":"fixture-rpc","clientTimeZone":"UTC"},"content":[{"type":"text","text":"$human"}]}"""),
            event("user/message", 2, """{"role":"user","source":{"kind":"agent-instructions","form":"instructions","baseline":true,"baselineIdentity":"fixture-baseline","changes":[{"action":"set","scope":"workspace","path":"AGENTS.md","digest":"fixture-digest"}]},"content":[{"type":"text","text":"$instructions"},{"type":"text","text":"$delta"}]}"""),
            event("user/message", 3, """{"role":"user","source":{"kind":"skill-catalog","form":"catalog","entries":[{"name":"fixture","description":"Skill sintética"}]},"content":[{"type":"text","text":"$skills"}]}"""),
            event("user/message", 4, """{"role":"user","source":{"kind":"goal","goalId":"fixture-goal","revision":1,"round":1},"content":[{"type":"text","text":"$goalPrompt"}]}"""),
            event("assistant/message", 5, """{"turn":1,"step":0,"message":{"content":[{"type":"text","text":"Resposta normal da conversa."}]}}"""))
        ui.setContent { CompanionTheme {
            CompanionScreen(CompanionUiState(authenticated = true, connected = true, selectedId = "fixture-debug",
                showModelContext = visible.value, richMessages = RichTranscriptProjection.render(records, null, visible.value)), InertActions())
        } }
        ui.waitUntil(5000) { ui.onAllNodesWithText(human).fetchSemanticsNodes().isNotEmpty() }
        ui.onNodeWithText(context).assertDoesNotExist()
        listOf(instructions, delta, skills).forEach { ui.onNodeWithText(it).assertDoesNotExist() }
        screenshot("task106-context-off.png")
        ui.runOnIdle { visible.value = true }
        ui.waitUntil(5000) { ui.onAllNodesWithText(context).fetchSemanticsNodes().isNotEmpty() }
        ui.onNodeWithText(context).assertIsDisplayed()
        listOf(instructions, delta, skills).forEach { text ->
            ui.waitUntil(5000) { ui.onAllNodesWithText(text).fetchSemanticsNodes().isNotEmpty() }
            ui.onNodeWithText(text).assertExists()
        }
        ui.onNodeWithText(goalPrompt).assertDoesNotExist()
        ui.onNodeWithText("Contexto · goal").assertDoesNotExist()
        screenshot("task106-context-on.png")
        ui.runOnIdle { visible.value = false }
        ui.waitUntil(5000) { ui.onAllNodesWithText(context).fetchSemanticsNodes().isEmpty() }
        listOf(instructions, delta, skills).forEach { ui.onNodeWithText(it).assertDoesNotExist() }
        ui.onNodeWithText(human).assertIsDisplayed()
        screenshot("task106-context-off-again.png")
    }

    private fun screenshot(name: String) {
        ui.waitForIdle()
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val committed = CountDownLatch(1)
        lateinit var window: Window
        instrumentation.runOnMainSync {
            window = ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED).single().window
            // Semantics can update before SurfaceFlinger presents the new buffer after a toggle.
            window.decorView.viewTreeObserver.registerFrameCommitCallback { committed.countDown() }
            window.decorView.invalidate()
        }
        assertTrue("App window did not commit its frame", committed.await(5, TimeUnit.SECONDS))
        val bitmap = Bitmap.createBitmap(window.decorView.width, window.decorView.height, Bitmap.Config.ARGB_8888)
        val copied = CountDownLatch(1)
        var result = -1
        PixelCopy.request(window, bitmap, { result = it; copied.countDown() }, Handler(Looper.getMainLooper()))
        assertTrue("App window capture did not complete", copied.await(5, TimeUnit.SECONDS))
        assertEquals(PixelCopy.SUCCESS, result)
        File(requireNotNull(instrumentation.targetContext.externalCacheDir), name).outputStream().use {
            assertTrue(bitmap.compress(Bitmap.CompressFormat.PNG, 100, it))
        }
        bitmap.recycle()
    }

    private open class InertActions : UiActions {
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
}
