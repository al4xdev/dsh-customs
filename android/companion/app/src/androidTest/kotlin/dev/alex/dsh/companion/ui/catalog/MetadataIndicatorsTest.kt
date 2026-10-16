package dev.alex.dsh.companion.ui.catalog

import androidx.compose.foundation.layout.Column
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.performClick
import dev.alex.dsh.companion.catalog.ConversationAttention
import dev.alex.dsh.companion.ui.premium.PremiumTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/** Fixture callbacks only; no VM, RPC, native controls, questions, SDK, model or provider calls. */
class MetadataIndicatorsTest {
    @get:Rule val compose = createComposeRule()
    @Test fun neutralCandidateHintCoexistsWithActualWorkWithoutInventingAmberWaiting() {
        compose.setContent { PremiumTheme { Column {
            ConversationActivityIndicators("chat", responding = true, unread = false, reduceMotion = true)
            InteractionCheckHint("chat")
        } } }
        compose.onNodeWithTag("chat-response-indicator:chat").assertExists()
        compose.onNodeWithTag("interaction-check:chat").assertExists()
        compose.onNodeWithContentDescription("Possíveis interações; abra para conferir").assertExists()
        compose.onNodeWithTag("chat-attention-indicator:chat").assertDoesNotExist()
    }
    @Test fun hostBannerRefreshIsOnlyAnExplicitReadCallback() {
        var reads = 0
        compose.setContent { PremiumTheme { HostMetadataBanner("Estado do serviço não confirmado; atualize para conferir.", true, { reads++ }) } }
        compose.runOnIdle { assertEquals(0, reads) }
        compose.onNodeWithTag("host-metadata-refresh").performClick()
        compose.runOnIdle { assertEquals(1, reads) }
    }
    @Test fun blockingPermissionSuppressesStaleWorkAndItsAmberPixelsDoNotAnimate() {
        compose.mainClock.autoAdvance = false
        compose.setContent { PremiumTheme {
            ConversationActivityIndicators("blocked", responding = true, unread = false,
                attention = ConversationAttention(approvals = 1))
        } }
        compose.mainClock.advanceTimeByFrame()
        compose.onNodeWithTag("chat-response-indicator:blocked").assertDoesNotExist()
        compose.onNodeWithContentDescription("Aguardando você: permissão pendente").assertExists()
        val first = compose.onNodeWithTag("chat-attention-indicator:blocked").captureToImage().toPixelMap()
        compose.mainClock.advanceTimeBy(475)
        val later = compose.onNodeWithTag("chat-attention-indicator:blocked").captureToImage().toPixelMap()
        assertTrue((0 until first.height).all { y -> (0 until first.width).all { x -> first[x, y] == later[x, y] } })
    }
    @Test fun continuedQuestionRetainsStaticAmberBesideIndependentRealWork() {
        compose.setContent { PremiumTheme {
            ConversationActivityIndicators("continued", responding = true, unread = false, reduceMotion = true,
                attention = ConversationAttention(continuedQuestions = 1))
        } }
        compose.onNodeWithTag("chat-response-indicator:continued").assertExists()
        compose.onNodeWithTag("chat-attention-indicator:continued").assertExists()
        compose.onNodeWithContentDescription("Agente trabalhando. Aguardando você: pergunta pendente").assertExists()
        compose.onNodeWithTag("chat-unread-indicator:continued").assertDoesNotExist()
    }
}
