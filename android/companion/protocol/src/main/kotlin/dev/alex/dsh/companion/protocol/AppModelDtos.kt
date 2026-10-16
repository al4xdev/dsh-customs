package dev.alex.dsh.companion.protocol

/** Descriptive receipts only: these DTOs never mint chat admission or prove a historical chat was changed. */
data class AppModelTarget(val sessionId: String, val createdAt: Long)
enum class AppModelFailureCode(val wireValue: String) {
    APPLY_FAILED("model-apply-failed"), SESSION_CHANGED("model-session-changed"), UNAVAILABLE("model-unavailable"),
}
data class AppModelFailedTarget(val sessionId: String, val createdAt: Long, val code: AppModelFailureCode)
data class AppModelResult(
    val current: ModelChoice,
    val applied: List<AppModelTarget>,
    val failed: List<AppModelFailedTarget>,
) {
    val scope: String get() = AppModelCodec.SCOPE
    val cold: String get() = AppModelCodec.COLD
}
