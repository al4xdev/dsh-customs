package dev.alex.dsh.companion.ui.settings

/** Display-only projection: never carries credential refs or raw provider failures. */
data class SettingsModelChoice(val provider: String, val model: String, val reasoningEffort: String? = null)

data class SettingsReasoningEffort(val id: String, val name: String, val description: String? = null)

data class SettingsModelOption(
    val provider: String,
    val providerName: String,
    val id: String,
    val name: String,
    val description: String? = null,
    val efforts: List<SettingsReasoningEffort> = emptyList(),
    val defaultEffort: String? = null,
) {
    val routeKey: String get() = "$provider\u0000$id"
    fun accepts(choice: SettingsModelChoice): Boolean = choice.provider == provider && choice.model == id &&
        (choice.reasoningEffort == null || efforts.any { it.id == choice.reasoningEffort })

    // Opening the current route preserves an explicit effort (notably low); a different
    // route starts at the adapter default, never a guessed effort copied across models.
    fun candidate(current: SettingsModelChoice?): SettingsModelChoice =
        current?.takeIf(::accepts) ?: SettingsModelChoice(provider, id)
}

enum class SettingsSelectionStatus { IDLE, SAVING, UNKNOWN }

data class SettingsUiState(
    // Global intent, not evidence of the actual model of every chat or an in-flight request.
    val defaultModel: SettingsModelChoice? = null,
    val models: List<SettingsModelOption> = emptyList(),
    val loading: Boolean = false,
    val error: String? = null,
    val unavailableProviders: Int = 0,
    val catalogVersion: Long = 0,
    val canSelectDefault: Boolean = false,
    val selectionStatus: SettingsSelectionStatus = SettingsSelectionStatus.IDLE,
    val selectionMessage: String? = null,
    val logoutEnabled: Boolean = false,
    val logoutBlockedReason: String? = null,
) {
    val selectorEnabled: Boolean get() = canSelectDefault && !loading && error == null &&
        defaultModel != null && models.isNotEmpty() && selectionStatus == SettingsSelectionStatus.IDLE

    fun accepts(choice: SettingsModelChoice): Boolean = selectorEnabled && models.any { it.accepts(choice) }
}

/** Filtering does not truncate availability; LazyColumn virtualizes all matching routes. */
fun filterSettingsModels(models: List<SettingsModelOption>, query: String): List<SettingsModelOption> {
    val needle = query.trim().take(160)
    return if (needle.isEmpty()) models else models.filter {
        it.name.contains(needle, ignoreCase = true) || it.id.contains(needle, ignoreCase = true) ||
            it.providerName.contains(needle, ignoreCase = true) || it.provider.contains(needle, ignoreCase = true)
    }
}

/** A catalog read can reconcile saved intent; it cannot recover a lost fanout receipt. */
const val APP_MODEL_INTENT_CONFIRMED_MESSAGE = "Padrão confirmado; aplicação anterior nas conversas não confirmada; será verificada antes do próximo envio."

fun appModelCatalogSelectionMessage(uncertain: Boolean, intentConfirmed: Boolean, previousMessage: String? = null): String? = when {
    uncertain -> APP_MODEL_UNCONFIRMED_BANNER
    intentConfirmed || previousMessage == APP_MODEL_INTENT_CONFIRMED_MESSAGE -> APP_MODEL_INTENT_CONFIRMED_MESSAGE
    else -> null
}
