package dev.alex.dsh.companion.ui

import dev.alex.dsh.companion.render.RichMessage
import dev.alex.dsh.companion.render.ToolPhase
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.TextStyle
import java.util.Locale

/** Short, human timestamp for the conversation list: "agora", "há 5 min", "14:32", "ontem", "seg", "12/10". */
internal fun relativeChatTime(nowMillis: Long, millis: Long, zone: ZoneId = ZoneId.systemDefault(), locale: Locale = Locale.getDefault()): String {
    val delta = nowMillis - millis
    if (delta < 0 || delta < 60_000) return "agora"
    if (delta < 3_600_000) return "há ${delta / 60_000} min"
    val then = Instant.ofEpochMilli(millis).atZone(zone)
    val today = Instant.ofEpochMilli(nowMillis).atZone(zone).toLocalDate()
    val days = today.toEpochDay() - then.toLocalDate().toEpochDay()
    return when {
        days <= 0 -> DateTimeFormatter.ofPattern("HH:mm", locale).format(then)
        days == 1L -> "ontem"
        days < 7 -> then.dayOfWeek.getDisplayName(TextStyle.SHORT, locale).trimEnd('.')
        else -> DateTimeFormatter.ofPattern("dd/MM", locale).format(then)
    }
}

/** Friendly verbs for tool names; unknown tools fall back to a neutral label, never a raw identifier. */
private fun toolVerb(name: String?): String = when (name?.lowercase()) {
    "read", "read_image", "list", "glob" -> "Lendo arquivos"
    "write", "edit", "apply_patch" -> "Editando arquivos"
    "bash", "shell" -> "Rodando comando"
    "grep" -> "Buscando no código"
    "research", "web_fetch", "browser" -> "Pesquisando"
    "subagent", "workflow" -> "Delegando tarefa"
    "wait" -> "Aguardando"
    else -> "Usando ferramenta"
}

/**
 * One line for the response in progress: the tool that is running now plus how many ran since the
 * last human message. Null when no tool is active, so the caller falls back to the generic phase text.
 */
internal fun liveActivityLabel(messages: List<RichMessage>): String? {
    val lastHuman = messages.indexOfLast { it.role == MessageRole.USER && (it.sourceKind == null || it.sourceKind == "user") }
    val turn = messages.drop(lastHuman + 1).filter { it.tool != null }
    val running = turn.lastOrNull { it.tool?.phase == ToolPhase.PREPARING || it.tool?.phase == ToolPhase.RUNNING } ?: return null
    val verb = toolVerb(running.tool?.name)
    return if (turn.size > 1) "$verb · ${turn.size} ferramentas" else verb
}
