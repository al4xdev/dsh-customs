package dev.alex.dsh.companion.catalog

/** Verified foreground answerer facts, not agent progress, completion, or a persisted response grant. */
data class ConversationAttention(
    val approvals: Int = 0,
    val blockingQuestions: Int = 0,
    val continuedQuestions: Int = 0,
    val pendingReplyConfirmation: Int = 0,
) {
    val awaitingUser: Boolean get() = approvals + blockingQuestions + continuedQuestions > 0
    val blocksOnUser: Boolean get() = approvals + blockingQuestions > 0
}
