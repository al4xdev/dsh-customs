package dev.alex.dsh.companion

/** Red banner text after a carrier loss; [chatOpen] tells whether the chat's reconnect row is visible. */
@Suppress("UNUSED_PARAMETER")
internal fun disconnectNotice(error: Exception?, chatOpen: Boolean): String? = when {
    error == null -> "Conexão encerrada. Reconecte para obter um histórico confirmado."
    error is IllegalStateException && error.message?.contains("overflow") == true -> "Saturação de buffer de mensagens. Reconectando…"
    else -> "Dados não suportados. Reconecte sem reenviar mensagens."
}
