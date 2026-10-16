package dev.alex.dsh.companion.ui.render

import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertHeightIsAtLeast
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.unit.dp
import dev.alex.dsh.companion.render.ActivityTranscriptProjection
import dev.alex.dsh.companion.render.ImageReference
import dev.alex.dsh.companion.render.RenderBlock
import dev.alex.dsh.companion.render.RichMessage
import dev.alex.dsh.companion.render.ToolPhase
import dev.alex.dsh.companion.render.ToolPresentation
import dev.alex.dsh.companion.render.TranscriptItem
import dev.alex.dsh.companion.ui.MessageRole
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/** Synthetic local transcript. No source/private image, service, model or execution callback. */
class ActivityGroupRendererTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test fun hundredToolsAreOneClosedLineAndExpandedRowsDoNotComposeEvidenceUntilSpecificDetailOpens() {
        val seenImages = mutableSetOf<String>()
        var inspections = 0
        val tools = (0..99).map { index ->
            val content = listOf(RenderBlock.Text("fixture-result-$index"),
                RenderBlock.Image(ImageReference("fixture-image-$index", "image/png", 12, 2, 2)))
            RichMessage(index.toLong(), MessageRole.TOOL, "fixture-result-$index", content,
                ToolPresentation("fixture-call-$index", "session", ToolPhase.OK, "{\"operation\":\"read\"}", content = content, resultSeq = index.toLong(), turn = 1),
                stableId = "tool:fixture-call-$index")
        }
        val group = dev.alex.dsh.companion.render.ActivityGroup("fixture-group", tools.map { dev.alex.dsh.companion.render.ActivityEntry(it) }, 1)
        compose.setContent {
            val folds = remember { RichRenderState() }
            MaterialTheme {
                Column(Modifier.width(320.dp).verticalScroll(rememberScrollState())) {
                    ActivityGroupCard(group, imageContent = { ref ->
                        SideEffect { seenImages += ref.attachmentId }
                        Text("fixture native image ${ref.attachmentId}")
                    }, renderState = folds, onInspect = {
                        assertTrue(!folds.expanded(group.stableId))
                        inspections++
                    })
                }
            }
        }
        compose.onNodeWithText("Atividade · 100 ferramentas").assertIsDisplayed()
        compose.onNodeWithContentDescription("Expandir atividade").assertHeightIsAtLeast(48.dp)
        compose.onNodeWithText("session · read").assertDoesNotExist()
        compose.onNodeWithText("fixture-result-0").assertDoesNotExist()
        compose.runOnIdle { assertTrue(seenImages.isEmpty()) }
        compose.onNodeWithContentDescription("Expandir atividade").performClick()
        compose.runOnIdle { assertEquals(1, inspections) }
        compose.onAllNodesWithText("session · read").assertCountEquals(100)
        compose.onNodeWithText("fixture-result-0").assertDoesNotExist()
        compose.runOnIdle { assertTrue(seenImages.isEmpty()) }
        compose.onAllNodesWithContentDescription("Expandir ferramenta")[0].performScrollTo().assertHeightIsAtLeast(48.dp).performClick()
        compose.onNodeWithText("fixture-result-0").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("fixture native image fixture-image-0").performScrollTo().assertIsDisplayed()
        compose.runOnIdle { assertEquals(setOf("fixture-image-0"), seenImages) }
        compose.onNodeWithContentDescription("Recolher atividade").performScrollTo().performClick()
        compose.runOnIdle { assertEquals(1, inspections) }
        compose.onNodeWithText("fixture-result-0").assertDoesNotExist()
        compose.onNodeWithText("fixture native image fixture-image-0").assertDoesNotExist()
        compose.onNodeWithContentDescription("Expandir atividade").performClick()
        compose.runOnIdle { assertEquals(2, inspections) }
        compose.onNodeWithText("fixture-result-0").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Copiar").assertDoesNotExist()
        compose.onNodeWithText("Executar").assertDoesNotExist()
    }

    @Test fun reasoningFoldSurvivesLiveMessageGainingNormalProseAndDurableSettlement() {
        val initial = RichMessage(0, MessageRole.ASSISTANT, "fixture thought", listOf(RenderBlock.Reasoning("fixture thought")),
            stableId = "assistant:1:0", streaming = true, turn = 1, step = 0)
        val current = mutableStateOf(initial)
        compose.setContent {
            val folds = remember { RichRenderState() }
            MaterialTheme {
                Column(Modifier.width(320.dp).verticalScroll(rememberScrollState())) {
                    ActivityTranscriptProjection.project(listOf(current.value)).forEach { item ->
                        when (item) {
                            is TranscriptItem.Message -> RichMessageCard(item.message, imageContent = { Text("unused image") }, renderState = folds)
                            is TranscriptItem.Activity -> ActivityGroupCard(item.group, imageContent = { Text("unused image") }, renderState = folds)
                            is TranscriptItem.Media -> Text("unused image")
                        }
                    }
                }
            }
        }
        compose.onNodeWithText("fixture thought").assertDoesNotExist()
        compose.onNodeWithContentDescription("Expandir atividade").performClick()
        compose.onNodeWithText("fixture thought").assertDoesNotExist()
        compose.onNodeWithText("Ver raciocínio").performClick()
        compose.onNodeWithText("fixture thought").assertIsDisplayed()
        compose.runOnIdle { current.value = initial.copy(blocks = listOf(RenderBlock.Reasoning("fixture thought updated"), RenderBlock.Text("fixture visible answer"))) }
        compose.onNodeWithContentDescription("Recolher atividade").assertIsDisplayed()
        compose.onNodeWithText("fixture thought updated").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("fixture visible answer").performScrollTo().assertIsDisplayed()
        compose.runOnIdle { current.value = current.value.copy(streaming = false) }
        compose.onNodeWithText("Ocultar raciocínio").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("fixture visible answer").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("DSH").assertDoesNotExist()
        compose.onNodeWithText("Você").assertDoesNotExist()
    }

    @Test fun onlyHumanHasRightAlignedBoundedBubbleAndAssistantRemainsFullWidthFlatContent() {
        val human = RichMessage(0, MessageRole.USER, "fixture human", listOf(RenderBlock.Text("fixture human")), stableId = "user:fixture")
        val assistant = RichMessage(1, MessageRole.ASSISTANT, "fixture answer", listOf(RenderBlock.Text("fixture answer")), stableId = "assistant:1:0")
        val context = RichMessage(2, MessageRole.USER, "fixture context", listOf(RenderBlock.Text("fixture context")), stableId = "context:fixture", sourceKind = "fixture-context")
        compose.setContent {
            MaterialTheme {
                Column(Modifier.width(320.dp).testTag("fixture-canvas")) {
                    RichMessageCard(human, imageContent = { Text("unused image") })
                    RichMessageCard(assistant, imageContent = { Text("unused image") })
                    RichMessageCard(context, imageContent = { Text("unused image") })
                }
            }
        }
        val canvas = compose.onNodeWithTag("fixture-canvas").fetchSemanticsNode().boundsInRoot
        val bubble = compose.onNodeWithTag("human-bubble:user:fixture").fetchSemanticsNode().boundsInRoot
        val prose = compose.onNodeWithTag("transcript-content:assistant:1:0").fetchSemanticsNode().boundsInRoot
        assertTrue(bubble.width <= canvas.width * .88f + 1f)
        assertEquals(canvas.right, bubble.right, 1f)
        assertEquals(canvas.width, prose.width, 1f)
        compose.onNodeWithTag("human-bubble:assistant:1:0").assertDoesNotExist()
        compose.onNodeWithTag("human-bubble:context:fixture").assertDoesNotExist()
        compose.onNodeWithText("fixture answer").assertIsDisplayed()
        compose.onNodeWithText("DSH").assertDoesNotExist()
        compose.onNodeWithText("Você").assertDoesNotExist()
    }

    @Test fun closedGroupKeepsErrorUnknownAndExplicitNativeHeaderFactsWithoutInventedCompletionOrTime() {
        val messages = listOf(ToolPhase.ERROR, ToolPhase.UNKNOWN).mapIndexed { index, phase ->
            RichMessage(index.toLong(), MessageRole.TOOL, "fixture result", emptyList(),
                ToolPresentation("fixture-$index", "session", phase, "{}", turn = 1), stableId = "tool:fixture-$index")
        }
        val group = (ActivityTranscriptProjection.project(messages).single() as TranscriptItem.Activity).group
        compose.setContent {
            MaterialTheme { ActivityGroupCard(group, imageContent = { Text("unused image") }, headerContent = { Text("fixture native response fact") }) }
        }
        compose.onNodeWithText("Atividade · 2 ferramentas").assertIsDisplayed()
        compose.onNodeWithText("1 erro · 1 sem status confirmado").assertIsDisplayed()
        compose.onNodeWithText("fixture native response fact").assertIsDisplayed()
        compose.onNodeWithText("Concluído").assertDoesNotExist()
        compose.onNodeWithText("Worked", substring = true).assertDoesNotExist()
        compose.onNodeWithText("fixture result").assertDoesNotExist()
    }
}
