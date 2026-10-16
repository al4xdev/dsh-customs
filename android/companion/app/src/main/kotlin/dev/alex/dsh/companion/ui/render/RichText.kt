package dev.alex.dsh.companion.ui.render

import android.content.ActivityNotFoundException
import android.content.Intent
import androidx.core.net.toUri
import androidx.compose.foundation.ScrollState
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.LinkInteractionListener
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import dev.alex.dsh.companion.render.MarkdownDecoration
import dev.alex.dsh.companion.render.MarkdownSnapshotWorker
import dev.alex.dsh.companion.render.MarkdownSource
import dev.alex.dsh.companion.render.MarkdownSpan
import dev.alex.dsh.companion.render.MarkdownTile
import dev.alex.dsh.companion.render.PreparedMarkdown
import dev.alex.dsh.companion.render.SafeLinks
import dev.alex.dsh.companion.render.TableLayout
import dev.alex.dsh.companion.ui.premium.workspaceGestureExcluded

/** Standalone details retain native selection. Transcript rows consume prepared tiles directly. */
@Composable
fun RichText(text: String, modifier: Modifier = Modifier, streaming: Boolean = false, onOpenLink: ((String) -> Unit)? = null) {
    var prepared by remember { mutableStateOf<PreparedMarkdown?>(null) }
    var preparedSource by remember { mutableStateOf<MarkdownSource?>(null) }
    val latestText by rememberUpdatedState(text)
    LaunchedEffect(Unit) {
        // Streaming is a fact label, not the worker lifetime: static/history/final source must
        // never trigger synchronous parsing or cancel a pending final version.
        MarkdownSnapshotWorker.collect(snapshotFlow { MarkdownSource.capture(latestText) }) { source, parsed ->
            val current = MarkdownSource.capture(latestText)
            if (current.text.startsWith(source.text) && (!source.limited || current.limited)) {
                preparedSource = source
                prepared = parsed
            }
        }
    }
    val current = MarkdownSource.capture(text)
    val matching = prepared?.takeIf { current.text.startsWith(it.source) && (preparedSource?.limited != true || current.limited) }
    val formatting = preparedSource != current
    val document = matching?.document
    val tiles = matching?.tiles.orEmpty()
    val renderState = remember { RichRenderState() }
    Column(modifier, verticalArrangement = Arrangement.spacedBy(10.dp)) {
        SelectionContainer {
            Column {
                tiles.forEachIndexed { index, tile ->
                    val following = tiles.getOrNull(index + 1)
                    val contiguous = tile is MarkdownTile.TableRow && following is MarkdownTile.TableRow && tile.tableKey == following.tableKey
                    val scroll = if (tile is MarkdownTile.TableRow) renderState.horizontalScroll(tile.tableKey) else null
                    PreparedMarkdownTile(tile, Modifier.padding(bottom = if (following == null || contiguous) 0.dp else 10.dp),
                        onOpenLink = onOpenLink, tableScrollState = scroll)
                }
            }
        }
        // Never measure a second, possibly64KiB literal Text while formatting is pending.
        // Source stays intact in the admitted model; only mounted text supports native selection.
        if (formatting) Text("Formatando texto", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        if (document?.hasMathSource == true) Text("Matemática em fonte literal; sem renderização matemática", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        if (document?.limited == true || current.limited) Text("Apresentação limitada", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.error)
        if (streaming) Text("Recebendo", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/** Resolved image cards and inert tiles must retain the same quote/list structure. */
@Composable
internal fun MarkdownDecorationLayout(decoration: MarkdownDecoration, modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    val quote = if (decoration.quoteDepth > 0) Modifier.background(MaterialTheme.colorScheme.surfaceContainerHigh, RoundedCornerShape(12.dp))
        .padding(horizontal = 12.dp, vertical = 8.dp) else Modifier
    Row(modifier.fillMaxWidth().padding(start = (decoration.quoteDepth * 12 + (decoration.listDepth - 1).coerceAtLeast(0) * 16).dp).then(quote),
        horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        if (decoration.listDepth > 0) Text(decoration.marker.orEmpty(), Modifier.width(28.dp), color = MaterialTheme.colorScheme.onSurfaceVariant)
        Column(Modifier.weight(1f)) { content() }
    }
}

/** No parsing or AST flattening here. The transcript supplies shared selection around its LazyColumn. */
@Composable
fun PreparedMarkdownTile(tile: MarkdownTile, modifier: Modifier = Modifier,
    onOpenLink: ((String) -> Unit)? = null, tableScrollState: ScrollState? = null) {
    MarkdownDecorationLayout(tile.decoration, modifier) {
        when (tile) {
            is MarkdownTile.Inline -> InlineText(tile.spans, heading = tile.heading, onOpenLink = onOpenLink)
            is MarkdownTile.Image -> Text(tile.fallback, style = MaterialTheme.typography.bodyMedium)
            is MarkdownTile.Literal -> Text(tile.source, style = MaterialTheme.typography.bodyMedium)
            is MarkdownTile.Rule -> HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            is MarkdownTile.Code -> Surface(color = MaterialTheme.colorScheme.surfaceContainerHighest, shape = RoundedCornerShape(12.dp)) {
                Column(Modifier.fillMaxWidth().workspaceGestureExcluded().padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    if (tile.fullSource != null) {
                        Text(tile.fallback ?: tile.language.takeIf(String::isNotBlank) ?: "Código", style = MaterialTheme.typography.labelMedium)
                    }
                    Text(tile.source, Modifier.horizontalScroll(tableScrollState ?: rememberScrollState()),
                        fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodyMedium)
                }
            }
            is MarkdownTile.TableRow -> NativeTableRow(tile, tableScrollState ?: rememberScrollState(), onOpenLink)
        }
    }
}

/** A row fragment owns only the table's outer corners, never a separate pill. */
internal fun tableFragmentShape(tile: MarkdownTile.TableRow) = RoundedCornerShape(
    topStart = if (tile.firstInTable) 12.dp else 0.dp,
    topEnd = if (tile.firstInTable) 12.dp else 0.dp,
    bottomEnd = if (tile.lastInTable) 12.dp else 0.dp,
    bottomStart = if (tile.lastInTable) 12.dp else 0.dp,
)

@Composable
private fun NativeTableRow(tile: MarkdownTile.TableRow, scroll: ScrollState, onOpenLink: ((String) -> Unit)?) {
    val density = LocalDensity.current
    val bodyEm = with(density) { MaterialTheme.typography.bodyLarge.fontSize.toDp() }.value
    val colors = MaterialTheme.colorScheme
    Surface(Modifier.fillMaxWidth().testTag("table-fragment:${tile.key}"), shape = tableFragmentShape(tile),
        color = if (tile.header) colors.surfaceContainerHigh else colors.surfaceContainerLow) {
        Column {
            // No separator or extra vertical padding inside a split row. The header's bottom
            // rule belongs to the next row start, so streamed header fragments stay continuous.
            if (tile.startsRow && !tile.firstInTable) HorizontalDivider(
                Modifier.testTag("table-rule:${tile.key}"), thickness = with(density) { 1f.toDp() }, color = colors.outlineVariant)
            BoxWithConstraints(Modifier.fillMaxWidth().workspaceGestureExcluded()) {
                val layout = TableLayout.columns(maxWidth.value, tile.columnCount, bodyEm, density.density)
                Column(Modifier.fillMaxWidth().horizontalScroll(scroll)) {
                    Row(Modifier.width(layout.contentWidthDp.dp).padding(
                        start = TableLayout.SIDE_PADDING_DP.dp, end = TableLayout.SIDE_PADDING_DP.dp,
                        top = if (tile.startsRow) 10.dp else 0.dp, bottom = if (tile.endsRow) 10.dp else 0.dp),
                        horizontalArrangement = Arrangement.spacedBy(TableLayout.COLUMN_GAP_DP.dp)) {
                        repeat(tile.columnCount.coerceIn(1, 16)) { column ->
                            Column(Modifier.width(layout.columnWidthDp.dp).testTag("table-cell:${tile.key}:$column")) {
                                InlineText(tile.cells.getOrNull(column).orEmpty(), strong = tile.header, onOpenLink = onOpenLink)
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun InlineText(spans: List<MarkdownSpan>, heading: Int? = null, strong: Boolean = false, onOpenLink: ((String) -> Unit)? = null) {
    val context = LocalContext.current
    val colors = MaterialTheme.colorScheme
    val annotated = remember(spans, strong, colors, context, onOpenLink) { buildAnnotatedString {
        spans.forEach { span ->
            val style = SpanStyle(fontWeight = if (span.bold || strong) FontWeight.SemiBold else null,
                fontStyle = if (span.italic) FontStyle.Italic else null,
                fontFamily = if (span.code) FontFamily.Monospace else null,
                textDecoration = if (span.strike) TextDecoration.LineThrough else null,
                background = if (span.code) colors.surfaceContainerHigh else androidx.compose.ui.graphics.Color.Unspecified)
            withStyle(style) {
                val target = span.link?.let(SafeLinks::accepted)
                if (target == null) append(span.text) else withLink(LinkAnnotation.Clickable(
                    tag = target,
                    styles = TextLinkStyles(style = SpanStyle(color = colors.primary, textDecoration = TextDecoration.Underline)),
                    linkInteractionListener = LinkInteractionListener {
                        if (onOpenLink != null) onOpenLink(target) else {
                            // Explicit click, no cookies/headers/grants. Missing handlers leave the text inert.
                            try {
                                context.startActivity(Intent(Intent.ACTION_VIEW, target.toUri()).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                            } catch (_: ActivityNotFoundException) { } catch (_: SecurityException) { }
                        }
                    },
                )) { append(span.text) }
            }
        }
    } }
    Text(annotated, style = when (heading) {
        1 -> MaterialTheme.typography.headlineMedium
        2 -> MaterialTheme.typography.headlineSmall
        3 -> MaterialTheme.typography.titleLarge
        4, 5, 6 -> MaterialTheme.typography.titleMedium
        else -> MaterialTheme.typography.bodyLarge
    })
}

@Composable
internal fun LiteralCode(source: String, label: String, modifier: Modifier = Modifier) {
    Surface(modifier.fillMaxWidth(), color = MaterialTheme.colorScheme.surfaceContainerHighest, shape = RoundedCornerShape(12.dp)) {
        Column(Modifier.workspaceGestureExcluded().padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(label, style = MaterialTheme.typography.labelMedium)
            SelectionContainer {
                Text(source.take(dev.alex.dsh.companion.render.RichRenderLimits.MAX_TEXT), modifier = Modifier.horizontalScroll(rememberScrollState()), fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodyMedium)
            }
            if (source.length > dev.alex.dsh.companion.render.RichRenderLimits.MAX_TEXT) Text("Prévia limitada", style = MaterialTheme.typography.labelSmall)
        }
    }
}
