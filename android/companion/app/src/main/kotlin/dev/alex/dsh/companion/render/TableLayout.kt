package dev.alex.dsh.companion.render

import kotlin.math.roundToInt

/** Geometry only: no row text measurement, source retention, or table-wide composition. */
internal data class TableColumnLayout(
    val columnWidthDp: Float,
    val contentWidthDp: Float,
    val fitsViewport: Boolean,
    val columnWidthsDp: List<Float> = emptyList(),
)

internal object TableLayout {
    const val SIDE_PADDING_DP = 12f
    const val COLUMN_GAP_DP = 16f

    fun columns(
        viewportWidthDp: Float,
        columnCount: Int,
        bodyEmDp: Float,
        pixelDensity: Float = 1f,
        columnMaxChars: List<Int>? = null,
    ): TableColumnLayout {
        require(!viewportWidthDp.isNaN() && viewportWidthDp >= 0 && bodyEmDp.isFinite() && bodyEmDp > 0)
        require(pixelDensity.isFinite() && pixelDensity > 0)
        val count = columnCount.coerceIn(1, 16)
        // Compose rounds padding, gaps and each width separately. Budget the same integer
        // pixels first; at density 2.625, two 140dp columns plus gutters need 842px, not 840.
        val sidePx = (SIDE_PADDING_DP * pixelDensity).roundToInt()
        val gapPx = (COLUMN_GAP_DP * pixelDensity).roundToInt()
        val guttersPx = sidePx * 2 + gapPx * (count - 1)
        // A standalone caller with unbounded width still receives finite native geometry.
        val viewportPx = if (viewportWidthDp.isFinite()) (viewportWidthDp * pixelDensity).roundToInt() else null
        val availablePx = viewportPx?.let { ((it - guttersPx) / count).coerceAtLeast(0) } ?: 0

        if (columnMaxChars != null && columnMaxChars.size == count) {
            val rawPx = columnMaxChars.map { chars ->
                when {
                    chars <= 3 -> (bodyEmDp * 3.5f * pixelDensity).roundToInt()
                    chars <= 10 -> (bodyEmDp * 7.5f * pixelDensity).roundToInt()
                    chars <= 25 -> (bodyEmDp * 12f * pixelDensity).roundToInt()
                    else -> (bodyEmDp * 16f * pixelDensity).roundToInt()
                }
            }
            val totalRawPx = rawPx.sum()
            val fits = viewportPx != null && (totalRawPx + guttersPx <= viewportPx)
            val widthsPx = if (fits && totalRawPx > 0) {
                val availableForCols = (requireNotNull(viewportPx) - guttersPx).coerceAtLeast(0)
                rawPx.map { (it.toFloat() / totalRawPx * availableForCols).roundToInt() }
            } else rawPx
            val widthsDp = widthsPx.map { it / pixelDensity }
            val contentPx = if (fits) requireNotNull(viewportPx).toFloat() else (widthsPx.sum() + guttersPx).toFloat()
            return TableColumnLayout(widthsDp.average().toFloat(), contentPx / pixelDensity, fits, widthsDp)
        }

        // Eight body ems can wrap short two-column records without shrinking native text.
        // Larger fonts and wider tables keep twelve ems per column and the shared real pan.
        val fits = count <= 2 && availablePx / pixelDensity >= bodyEmDp * 8
        val widthPx = if (fits) availablePx else (bodyEmDp * 12 * pixelDensity).roundToInt()
        // A fit keeps at most count-1 spare pixels at the trailing edge, never by squeezing
        // the last column. Overflow must also sum rounded components, not rounded total dp.
        val contentPx = if (fits) requireNotNull(viewportPx).toFloat() else widthPx.toFloat() * count + guttersPx
        val equalWidthsDp = List(count) { widthPx / pixelDensity }
        return TableColumnLayout(widthPx / pixelDensity, contentPx / pixelDensity, fits, equalWidthsDp)
    }
}
