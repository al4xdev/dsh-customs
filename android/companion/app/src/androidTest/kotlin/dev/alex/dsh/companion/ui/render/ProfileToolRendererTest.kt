package dev.alex.dsh.companion.ui.render

import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.test.assertHeightIsAtLeast
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import dev.alex.dsh.companion.render.ImageReference
import dev.alex.dsh.companion.render.RenderBlock
import dev.alex.dsh.companion.render.RichMessage
import dev.alex.dsh.companion.render.ToolPhase
import dev.alex.dsh.companion.render.ToolPresentation
import dev.alex.dsh.companion.ui.MessageRole
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.Parameterized

/** Local presentation only; includes a future-name fallback, never a live invocation. */
@RunWith(Parameterized::class)
class ProfileToolRendererTest(private val name: String) {
    companion object {
        @JvmStatic @Parameterized.Parameters(name = "{0}")
        fun inventory(): Collection<Array<String>> = listOf("session", "list", "read", "read_image", "write", "edit", "bash", "future.tool").map { arrayOf(it) }
    }
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test fun compactRootHidesTechnicalIdentityAndHeavyResultUntilFoldAndKeepsLiveStatus() {
        val id = "fixture-long-call-identity-provider-identity-opaque-not-a-header"
        val image = RenderBlock.Image(ImageReference("fixture-image", "image/png", 12, 2, 2))
        val initial = RichMessage(0, MessageRole.TOOL, "fixture", emptyList(),
            ToolPresentation(id, name, ToolPhase.RUNNING, "{\"operation\":\"fixture-help\"}"), stableId = "tool:$id")
        val current = mutableStateOf(initial)
        var images = 0
        compose.setContent {
            val density = LocalDensity.current
            val folds = remember { RichRenderState() }
            CompositionLocalProvider(LocalDensity provides Density(density.density, 1.7f)) {
                MaterialTheme {
                    Column(Modifier.width(320.dp).verticalScroll(rememberScrollState())) {
                        RichMessageCard(current.value, imageContent = {
                            SideEffect { images++ }
                            Text("fixture native image")
                        }, renderState = folds)
                    }
                }
            }
        }
        compose.onNodeWithText("$name · fixture-help").assertIsDisplayed()
        compose.onNodeWithText("Aguardando resultado").assertIsDisplayed()
        compose.onNodeWithText(id).assertDoesNotExist()
        compose.onNodeWithText("DSH").assertDoesNotExist()
        compose.onNodeWithText("Ferramenta").assertDoesNotExist()
        compose.onNodeWithContentDescription("Expandir ferramenta").assertHeightIsAtLeast(48.dp)
        compose.runOnIdle {
            val content = listOf(RenderBlock.Text("fixture result"), image)
            current.value = initial.copy(blocks = content, tool = initial.tool!!.copy(phase = ToolPhase.ERROR, content = content, resultSeq = 1))
        }
        compose.onNodeWithText("Erro").assertIsDisplayed()
        compose.onNodeWithText("fixture result").assertDoesNotExist()
        compose.onNodeWithText("fixture native image").assertDoesNotExist()
        compose.runOnIdle { assertEquals(0, images) }
        compose.onNodeWithContentDescription("Expandir ferramenta").performScrollTo().performClick()
        compose.onNodeWithText(id).performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("operation").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("fixture-help").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("fixture native image").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Copiar").assertDoesNotExist()
        compose.onNodeWithText("Executar").assertDoesNotExist()
        compose.onNodeWithContentDescription("Recolher ferramenta").performScrollTo().performClick()
        compose.onNodeWithText(id).assertDoesNotExist()
        compose.onNodeWithText("fixture native image").assertDoesNotExist()
    }
}
