package dev.alex.dsh.companion.ui.settings

import dev.alex.dsh.companion.protocol.*
import org.junit.Assert.*
import org.junit.Test

class AppModelBannerTest {
    private val choice = ModelChoice("synthetic", "new", "high")
    @Test fun partialBannerDescribesIntentLoadedReceiptsAndColdNextSend() {
        val text = appModelBanner(AppModelResult(choice, listOf(AppModelTarget("a", 1)), listOf(AppModelFailedTarget("b", 2, AppModelFailureCode.UNAVAILABLE))))
        assertTrue(text.contains("global salva com aplicação parcial")); assertTrue(text.contains("1 conversas carregadas"))
        assertTrue(text.contains("1 não confirmadas")); assertTrue(text.contains("Históricas: aplicar no próximo envio"))
        assertTrue(text.contains("já iniciadas não mudam")); assertFalse(text.contains("todas as conversas foram"))
    }
    @Test fun zeroLiveTargetsDoesNotMeanAllStoredChatsWereChanged() {
        val text = appModelBanner(AppModelResult(choice, emptyList(), emptyList()))
        assertTrue(text.startsWith("Escolha global salva.")); assertTrue(text.contains("0 conversas carregadas"))
        assertTrue(text.contains("próximas etapas")); assertFalse(text.contains("aplicação parcial"))
    }
    @Test fun unavailableOrUnconfirmedNeverClaimsLegacyFallbackOrAutomaticRetry() {
        assertTrue(APP_MODEL_UNCONFIRMED_BANNER.contains("indisponível ou não confirmada"))
        assertTrue(APP_MODEL_UNCONFIRMED_BANNER.contains("Atualize o estado"))
        assertFalse(APP_MODEL_UNCONFIRMED_BANNER.contains("padrão anterior aplicado"))
        assertFalse(APP_MODEL_UNCONFIRMED_BANNER.contains("tentando novamente"))
    }
}
