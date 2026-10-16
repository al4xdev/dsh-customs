package dev.alex.dsh.companion.catalog

/** Attention and unread are independent facts; neither is evidence that work completed. */
internal data class ConversationIndicatorFacts(
    val working: Boolean,
    val unread: Boolean,
    val awaitingUser: Boolean,
    val pendingConfirmation: Boolean,
) {
    val hasIndicator: Boolean get() = working || unread || awaitingUser || pendingConfirmation
}

internal fun conversationIndicatorFacts(
    responding: Boolean,
    unread: Boolean,
    attention: ConversationAttention,
): ConversationIndicatorFacts = ConversationIndicatorFacts(
    // Continued questions do not block an independently running model/tool operation.
    working = responding && !attention.blocksOnUser,
    unread = unread,
    awaitingUser = attention.awaitingUser,
    pendingConfirmation = attention.pendingReplyConfirmation > 0,
)
