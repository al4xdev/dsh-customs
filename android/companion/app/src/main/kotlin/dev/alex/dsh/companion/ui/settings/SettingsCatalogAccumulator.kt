package dev.alex.dsh.companion.ui.settings

import dev.alex.dsh.companion.protocol.ModelCatalogPage
import dev.alex.dsh.companion.protocol.ModelChoice
import dev.alex.dsh.companion.protocol.ModelOption

/** One bounded read sequence; no partially loaded catalog can authorize a write. */
class SettingsCatalogAccumulator {
    private var baseline: ModelCatalogPage? = null
    private val rows = linkedMapOf<String, ModelOption>()
    private val cursors = mutableSetOf<String>()
    private var pages = 0
    val models: List<ModelOption> get() = rows.values.toList()
    val metadata: ModelCatalogPage get() = checkNotNull(baseline)

    fun add(page: ModelCatalogPage) {
        check(++pages <= 4096) { "model-page-limit" }
        baseline?.let { first ->
            check(first.current == page.current && first.routableProviders == page.routableProviders &&
                first.writable == page.writable && first.unavailableProviders == page.unavailableProviders) { "model-catalog-changed" }
        } ?: run { baseline = page }
        for (model in page.models) {
            check(rows.put("${model.provider}\u0000${model.id}", model) == null) { "model-catalog-duplicate" }
            check(rows.size <= 4096) { "model-catalog-limit" }
        }
        page.nextCursor?.let {
            check(page.models.isNotEmpty() && cursors.add(it)) { "model-catalog-no-progress" }
        }
    }
}

/** An unchanged old value never proves an uncertain write failed or enables replay. */
fun confirmedPendingDefault(current: ModelChoice, pending: ModelChoice?, previous: ModelChoice?): Boolean =
    pending != null && current != previous && current.provider == pending.provider && current.model == pending.model &&
        (pending.reasoningEffort == null || current.reasoningEffort == pending.reasoningEffort)
