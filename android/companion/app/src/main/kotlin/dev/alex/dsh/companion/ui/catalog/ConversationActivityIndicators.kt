package dev.alex.dsh.companion.ui.catalog

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.MotionDurationScale
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import dev.alex.dsh.companion.catalog.ConversationAttention
import dev.alex.dsh.companion.catalog.conversationIndicatorFacts
import dev.alex.dsh.companion.ui.premium.PremiumPalette

/** Only actual work owns a clock. A human wait is static and never acknowledges unread text. */
@Composable
internal fun ConversationActivityIndicators(
    sessionId: String,
    responding: Boolean,
    unread: Boolean,
    modifier: Modifier = Modifier,
    visible: Boolean = true,
    reduceMotion: Boolean = false,
    attention: ConversationAttention = ConversationAttention(),
) {
    val facts = conversationIndicatorFacts(responding, unread, attention)
    if (!visible || !facts.hasIndicator) return
    val labels = buildList {
        if (facts.working) add("Agente trabalhando")
        if (facts.awaitingUser) add(when {
            attention.approvals > 0 -> "Aguardando você: permissão pendente"
            else -> "Aguardando você: pergunta pendente"
        })
        if (facts.pendingConfirmation) add("Resposta enviada; confirmação pendente")
        // Preserve the standalone accessibility label while keeping combined states natural.
        if (facts.unread) add(if (isEmpty()) "Mensagem não lida" else "Há mensagem não lida")
    }
    val tag = when {
        facts.working -> "chat-response-indicator:$sessionId"
        facts.awaitingUser -> "chat-attention-indicator:$sessionId"
        facts.unread -> "chat-unread-indicator:$sessionId"
        else -> "chat-reply-pending-indicator:$sessionId"
    }
    Row(modifier.height(22.dp).widthIn(min = 22.dp).testTag(tag).semantics {
        contentDescription = labels.joinToString(". ")
        role = Role.Image
    }, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp, Alignment.End)) {
        if (facts.working) WorkingRing(reduceMotion)
        if (facts.awaitingUser) {
            val ink = MaterialTheme.colorScheme.onTertiary
            // A continued question can coexist with real work; retain a separate static amber mark.
            val marker = if (facts.working) Modifier.testTag("chat-attention-indicator:$sessionId") else Modifier
            Canvas(marker.size(12.dp)) {
                drawCircle(PremiumPalette.Warning)
                drawLine(ink, Offset(center.x, 3.dp.toPx()), Offset(center.x, 6.5.dp.toPx()), 1.3.dp.toPx(), StrokeCap.Round)
                drawCircle(ink, radius = .7.dp.toPx(), center = Offset(center.x, 9.dp.toPx()))
            }
        } else if (!facts.working && facts.unread) {
            Canvas(Modifier.size(10.dp)) { drawCircle(PremiumPalette.Success) }
        } else if (!facts.working && facts.pendingConfirmation) {
            val ink = MaterialTheme.colorScheme.onSurfaceVariant
            Canvas(Modifier.size(12.dp)) {
                drawCircle(ink, radius = (size.minDimension - 1.5.dp.toPx()) / 2, style = Stroke(1.5.dp.toPx()))
                drawCircle(ink, radius = 1.dp.toPx())
            }
        }
    }
}

@Composable
private fun WorkingRing(reduceMotion: Boolean) {
    val scope = rememberCoroutineScope()
    val instant = reduceMotion || scope.coroutineContext[MotionDurationScale]?.scaleFactor == 0f
    val rotation = if (instant) 0f else {
        val transition = rememberInfiniteTransition(label = "conversation-working")
        val angle by transition.animateFloat(0f, 360f,
            infiniteRepeatable(tween(950, easing = LinearEasing)), label = "working-rotation")
        angle
    }
    val color = MaterialTheme.colorScheme.primary
    Canvas(Modifier.size(16.dp).graphicsLayer { rotationZ = rotation }) {
        val stroke = Stroke(width = 1.8.dp.toPx(), cap = StrokeCap.Round)
        drawCircle(color.copy(alpha = .18f), radius = (size.minDimension - stroke.width) / 2, style = stroke)
        val inset = stroke.width / 2
        drawArc(color, startAngle = -90f, sweepAngle = 265f, useCenter = false,
            topLeft = Offset(inset, inset),
            size = Size(size.width - stroke.width, size.height - stroke.width), style = stroke)
    }
}
