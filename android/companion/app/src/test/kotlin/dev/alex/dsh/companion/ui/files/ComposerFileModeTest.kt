package dev.alex.dsh.companion.ui.files

import org.junit.Assert.*
import org.junit.Test

class ComposerFileModeTest {
    @Test fun emptyOrWhitespaceWithoutReadyFilesAttaches() {
        listOf("", " ", "\n\t").forEach { assertEquals(ComposerFileMode.ATTACH, composerFileMode(it, 0)) }
    }
    @Test fun actualTextOrReadyLocalFileSends() {
        assertEquals(ComposerFileMode.SEND, composerFileMode("owner text", 0))
        assertEquals(ComposerFileMode.SEND, composerFileMode("", 1))
        assertEquals(ComposerFileMode.SEND, composerFileMode(" \n", 4))
    }
    @Test fun countIsBoundedAndLabelsAreSingleStableActions() {
        assertThrows(IllegalArgumentException::class.java) { composerFileMode("", -1) }
        assertThrows(IllegalArgumentException::class.java) { composerFileMode("", 5) }
        assertEquals("Anexar arquivo", ComposerFileMode.ATTACH.label); assertEquals("Enviar", ComposerFileMode.SEND.label)
    }
}
