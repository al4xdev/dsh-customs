package dev.alex.dsh.companion.delivery

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class AnswererReconnectPolicyTest {
    @Test fun transportLossBacksOffToACapAndDataErrorsWaitForTheOwner() {
        val now = 0L
        val policy = AnswererReconnectPolicy { now }
        val delays = List(8) { policy.failed(retryable = true) }
        assertEquals(listOf(1_000L, 2_000L, 5_000L, 10_000L, 20_000L, 30_000L, 30_000L, 30_000L), delays)
        assertNull(policy.failed(retryable = false))
        policy.reset()
        assertEquals(1_000L, policy.failed(retryable = true))
    }

    @Test fun onlyACarrierThatStayedReadyRestartsTheLadder() {
        var now = 0L
        val policy = AnswererReconnectPolicy { now }
        policy.failed(retryable = true); policy.failed(retryable = true)
        // A carrier that flaps right after ready keeps backing off instead of hammering the host.
        policy.ready(); now += 1_000
        assertEquals(5_000L, policy.failed(retryable = true))
        policy.ready(); now += AnswererReconnectPolicy.HEALTHY_MILLIS
        assertEquals(1_000L, policy.failed(retryable = true))
        // A refused/data failure after a healthy carrier still waits for an explicit action.
        policy.ready(); now += AnswererReconnectPolicy.HEALTHY_MILLIS
        assertNull(policy.failed(retryable = false))
        assertEquals(1_000L, policy.failed(retryable = true))
    }
}
