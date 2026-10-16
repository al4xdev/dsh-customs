package dev.alex.dsh.companion.catalog

/** Verified foreground answerer facts, not agent progress, completion, or a persisted response grant. */
data class ConversationAttention(
    val approvals: Int = 0,
    val blockingQuestions: Int = 0,
    val continuedQuestions: Int = 0,
    val pendingReplyConfirmation: Int = 0,
    // Live requests this app cannot present safely; the owner answers them on the PC.
    val unsupported: Int = 0,
) {
    val awaitingUser: Boolean get() = approvals + blockingQuestions + continuedQuestions + unsupported > 0
    val blocksOnUser: Boolean get() = approvals + blockingQuestions + unsupported > 0
}
