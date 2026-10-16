package dev.alex.dsh.companion.ui.files

import dev.alex.dsh.companion.protocol.FileUploadLimits

enum class ComposerFileMode(val label: String) { ATTACH("Anexar arquivo"), SEND("Enviar") }

/** Ready means local validated selection, not uploaded; transfer starts only on explicit Send. */
fun composerFileMode(text: String, readyFileCount: Int): ComposerFileMode {
    require(readyFileCount in 0..FileUploadLimits.MAX_FILES)
    return if (text.isNotBlank() || readyFileCount > 0) ComposerFileMode.SEND else ComposerFileMode.ATTACH
}
