package dev.alex.dsh.companion.ui

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.material3.LocalContentColor
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp

enum class CompanionGlyph { Back, Add, Logout, Settings, More, ChevronDown, ChevronUp, Stop, Send, Goal, Replying, Pause, Continue, Check }

/** One chevron that turns 180° instead of swapping two icons. */
@Composable
fun FoldChevron(expanded: Boolean, contentDescription: String?, modifier: Modifier = Modifier) {
    val rotation by animateFloatAsState(
        targetValue = if (expanded) 180f else 0f,
        animationSpec = tween(320),
        label = "fold-chevron",
    )
    CompanionIcon(CompanionGlyph.ChevronDown, contentDescription, modifier.graphicsLayer { rotationZ = rotation })
}

/** Small glyphs share one stroke; their enclosing IconButtons keep the 48dp hit targets. */
@Composable
fun CompanionIcon(glyph: CompanionGlyph, contentDescription: String?, modifier: Modifier = Modifier) {
    val color = LocalContentColor.current
    val label = if (contentDescription == null) Modifier else Modifier.semantics {
        this.contentDescription = contentDescription
        role = Role.Image
    }
    Canvas(modifier.size(20.dp).then(label)) {
        val w = size.width
        val h = size.height
        val stroke = 1.7.dp.toPx()
        fun line(x1: Float, y1: Float, x2: Float, y2: Float) = drawLine(
            color, Offset(w * x1, h * y1), Offset(w * x2, h * y2), strokeWidth = stroke, cap = StrokeCap.Round,
        )
        when (glyph) {
            CompanionGlyph.Back -> {
                line(.2f, .5f, .8f, .5f); line(.2f, .5f, .48f, .22f); line(.2f, .5f, .48f, .78f)
            }
            CompanionGlyph.Add -> { line(.2f, .5f, .8f, .5f); line(.5f, .2f, .5f, .8f) }
            CompanionGlyph.More -> for (y in listOf(.23f, .5f, .77f)) drawCircle(color, w * .065f, Offset(w * .5f, h * y))
            CompanionGlyph.Settings -> {
                drawCircle(color, w * .26f, style = androidx.compose.ui.graphics.drawscope.Stroke(stroke))
                drawCircle(color, w * .085f, style = androidx.compose.ui.graphics.drawscope.Stroke(stroke))
                for (step in 0 until 8) {
                    val angle = step * kotlin.math.PI / 4
                    val x = kotlin.math.cos(angle).toFloat()
                    val y = kotlin.math.sin(angle).toFloat()
                    line(.5f + x * .28f, .5f + y * .28f, .5f + x * .4f, .5f + y * .4f)
                }
            }
            CompanionGlyph.Logout -> {
                line(.4f, .2f, .15f, .2f); line(.15f, .2f, .15f, .8f); line(.15f, .8f, .4f, .8f)
                line(.4f, .5f, .88f, .5f); line(.64f, .27f, .88f, .5f); line(.64f, .73f, .88f, .5f)
            }
            CompanionGlyph.ChevronDown -> { line(.2f, .36f, .5f, .64f); line(.5f, .64f, .8f, .36f) }
            CompanionGlyph.ChevronUp -> { line(.2f, .64f, .5f, .36f); line(.5f, .36f, .8f, .64f) }
            CompanionGlyph.Stop -> drawRoundRect(color, Offset(w * .27f, h * .27f), Size(w * .46f, h * .46f), CornerRadius(w * .06f))
            CompanionGlyph.Send -> {
                line(.5f, .18f, .5f, .82f); line(.5f, .18f, .22f, .46f); line(.5f, .18f, .78f, .46f)
            }
            CompanionGlyph.Goal -> {
                line(.27f, .18f, .27f, .86f)
                line(.27f, .2f, .77f, .2f); line(.77f, .2f, .65f, .37f)
                line(.65f, .37f, .77f, .54f); line(.77f, .54f, .27f, .54f)
            }
            CompanionGlyph.Replying -> {
                drawRoundRect(color, Offset(w * .14f, h * .18f), Size(w * .72f, h * .52f),
                    CornerRadius(w * .12f), style = androidx.compose.ui.graphics.drawscope.Stroke(stroke))
                line(.3f, .7f, .3f, .84f); line(.3f, .84f, .46f, .7f)
                for (x in listOf(.33f, .5f, .67f)) drawCircle(color, w * .035f, Offset(w * x, h * .44f))
            }
            CompanionGlyph.Pause -> { line(.37f, .24f, .37f, .76f); line(.63f, .24f, .63f, .76f) }
            CompanionGlyph.Continue -> {
                line(.35f, .22f, .73f, .5f); line(.73f, .5f, .35f, .78f); line(.35f, .78f, .35f, .22f)
            }
            CompanionGlyph.Check -> { line(.2f, .52f, .42f, .74f); line(.42f, .74f, .82f, .28f) }
        }
    }
}
