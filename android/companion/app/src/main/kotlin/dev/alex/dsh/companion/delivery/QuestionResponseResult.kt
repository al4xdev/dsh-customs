package dev.alex.dsh.companion.delivery

import dev.alex.dsh.companion.protocol.ProtocolException
import dev.alex.dsh.companion.protocol.RpcResult
import dev.alex.dsh.companion.protocol.requireValue
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull

/** Transport ACKs never prove durable settlement. Unclassified errors preserve ambiguous admission. */
internal fun RpcResult.questionAcknowledgement(continued: Boolean): Boolean? = when (this) {
    is RpcResult.Failure -> {
        // Current SDK HarnessError may arrive as gateway/internal; never parse its diagnostic text.
        // Only an actual stable typed business code can tell us another reply is already queued.
        if (continued && code == "REPLY_QUEUED") true else null
    }
    is RpcResult.Success -> if (!continued) true else {
        val value = (requireValue() as? JsonPrimitive)?.takeUnless { it.isString }?.booleanOrNull
        value ?: throw ProtocolException("question-answer-result")
    }
}
