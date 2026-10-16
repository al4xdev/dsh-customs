package dev.alex.dsh.companion.delivery

import dev.alex.dsh.companion.protocol.AppModelCodec
import dev.alex.dsh.companion.protocol.AppModelTarget
import dev.alex.dsh.companion.protocol.ModelChoice
import kotlinx.serialization.json.JsonElement

internal class AppModelPreflightFailure : IllegalStateException("app-model-preflight-unconfirmed")

/** One explicit human intent, not a queue: no cached choice, retry, fallback or business admission. */
internal suspend fun requireCurrentAppModel(
    target: AppModelTarget,
    isCurrent: () -> Boolean,
    readCurrent: suspend () -> ModelChoice,
    apply: suspend (ModelChoice) -> JsonElement,
) {
    fun requireCurrent() { if (!isCurrent()) throw AppModelPreflightFailure() }
    requireCurrent()
    val current = readCurrent()
    requireCurrent()
    val value = apply(current)
    requireCurrent()
    val receipt = AppModelCodec.applied(value, target, current)
    // A failed row is a valid descriptive DTO, but can never authorize the following human submit.
    if (receipt.applied != listOf(target) || receipt.failed.isNotEmpty()) throw AppModelPreflightFailure()
}
