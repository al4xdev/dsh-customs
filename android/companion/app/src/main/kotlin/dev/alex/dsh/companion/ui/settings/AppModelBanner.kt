package dev.alex.dsh.companion.ui.settings

import dev.alex.dsh.companion.protocol.AppModelResult

const val APP_MODEL_UNCONFIRMED_BANNER = "Seleção global indisponível ou não confirmada. Atualize o estado antes de tentar novamente."

/** Global intent plus a bounded live receipt, never an actual per-chat route badge. */
fun appModelBanner(result: AppModelResult): String {
    val intent = if (result.failed.isEmpty()) "Escolha global salva." else "Escolha global salva com aplicação parcial."
    return "$intent Para próximas etapas: ${result.applied.size} conversas carregadas atualizadas; " +
        "${result.failed.size} não confirmadas. Históricas: aplicar no próximo envio. " +
        "Requisições já iniciadas não mudam."
}
