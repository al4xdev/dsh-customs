package dev.alex.dsh.companion.net

/** Shared transport/VM classification: cancelling an observation must never cancel a model mutation. */
internal object NativeRpcPolicy {
    val metadataReads = setOf("companionHost/status", "companion/catalogState", "companion/interactionHeads")
    val foregroundReads = setOf(
        "companion/listChats", "companion/detail", "companion/modelCatalog", "companion/messageHeads",
        "session/page", "session/projections", "nativeGoals/read", "nativeGoals/catalog",
    ) + metadataReads
    val interactions = setOf("\$events/result", "userQuestions/answer")
    val methods = foregroundReads + interactions + setOf(
        "session/create", "companion/deleteChat", "companion/selectDefaultModel",
        "companion/selectAppModel", "companion/applyAppModel",
        "session/prompt", "session/cancel", "session/updateQueue", "nativeGoals/control", "goalPush/register",
    )
    fun responseLimit(method: String): Long = if (method in metadataReads || method == "companion/messageHeads") 32L * 1024 else 4L * 1024 * 1024
}
