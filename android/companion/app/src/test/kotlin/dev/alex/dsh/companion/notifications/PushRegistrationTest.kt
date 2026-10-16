package dev.alex.dsh.companion.notifications

import org.junit.Assert.*
import org.junit.Test

class PushRegistrationTest {
    private val now = 1_800_000_000_000L
    private val sid = "session-11111111-1111-4111-8111-111111111111"
    private val device = "33333333-3333-4333-8333-333333333333"
    private val request = PushRegistrationRequest(deviceId = device, token = "fixture-token-not-real",
        tokenDigest = PushRegistrationPolicy.sha256("fixture-token-not-real"), configDigest = "c".repeat(64),
        authGeneration = 12, sessionIds = setOf(sid))
    private val receipt = PushRegistrationReceipt(1, "44444444-4444-4444-8444-444444444444",
        "55555555-5555-4555-8555-555555555555", "companion", "d".repeat(64), device,
        request.tokenDigest, request.configDigest, request.authGeneration, request.sessionIds, now, now + 60_000)
    private val native = mapOf("version" to "1", "eventId" to "a".repeat(64), "sessionId" to sid,
        "goalId" to "goal-22222222-2222-4222-8222-222222222222", "revision" to "7",
        "phase" to "completed", "timestamp" to now.toString())
    private fun envelope() = native + mapOf("bindingId" to receipt.bindingId, "deviceId" to receipt.deviceId,
        "ownerScopeId" to receipt.ownerScopeId, "registrationId" to receipt.registrationId,
        "authGeneration" to receipt.authGeneration.toString(), "configDigest" to receipt.configDigest, "tokenDigest" to receipt.tokenDigest)

    @Test fun exactPendingAuthenticatedReceiptIsAccepted() {
        assertTrue(PushRegistrationPolicy.validRequest(request))
        assertTrue(PushRegistrationPolicy.accepts(receipt, request, 12, now))
    }

    @Test fun staleGenerationAndRotatedTokenOrProjectAreRejected() {
        assertFalse(PushRegistrationPolicy.accepts(receipt, request, 13, now))
        listOf(receipt.copy(authGeneration = 11), receipt.copy(tokenDigest = "e".repeat(64)),
            receipt.copy(configDigest = "e".repeat(64)), receipt.copy(deviceId = receipt.bindingId)).forEach {
            assertFalse(PushRegistrationPolicy.accepts(it, request, 12, now))
        }
    }

    @Test fun responseCannotGrantForeignSessionOrProfile() {
        assertFalse(PushRegistrationPolicy.accepts(receipt.copy(sessionIds = setOf("session-99999999-9999-4999-8999-999999999999")), request, 12, now))
        assertFalse(PushRegistrationPolicy.accepts(receipt.copy(profile = "other"), request, 12, now))
        assertFalse(PushRegistrationPolicy.accepts(receipt.copy(ownerScopeId = "operator-name"), request, 12, now))
    }

    @Test fun leaseBoundsAndFutureClockSkewFailClosed() {
        assertFalse(PushRegistrationPolicy.validReceipt(receipt.copy(expiresAt = now), now))
        assertFalse(PushRegistrationPolicy.validReceipt(receipt.copy(issuedAt = now + 300_001), now))
        assertFalse(PushRegistrationPolicy.validReceipt(receipt.copy(expiresAt = now + PushRegistrationPolicy.MAX_LEASE_MS + 1), now))
        assertFalse(PushRegistrationPolicy.validReceipt(receipt.copy(issuedAt = 0), now))
    }

    @Test fun tokenAndSessionListAreBoundedAndRequestStringIsRedacted() {
        assertFalse(request.toString().contains(request.token))
        val tooLarge = PushRegistrationRequest(deviceId = device, token = "x".repeat(4097),
            tokenDigest = PushRegistrationPolicy.sha256("x".repeat(4097)), configDigest = request.configDigest,
            authGeneration = 12, sessionIds = setOf(sid))
        assertFalse(PushRegistrationPolicy.validRequest(tooLarge))
        assertFalse(PushRegistrationPolicy.validReceipt(receipt.copy(sessionIds = emptySet()), now))
    }

    @Test fun dataOnlyEnvelopeBindsEveryNativeAndRecipientIdentity() {
        assertEquals(native, PushRegistrationPolicy.unwrapFcm(envelope(), receipt, now))
        listOf("bindingId", "deviceId", "ownerScopeId", "registrationId", "authGeneration", "configDigest", "tokenDigest").forEach {
            assertNull(it, PushRegistrationPolicy.unwrapFcm(envelope() + (it to "wrong"), receipt, now))
            assertNull(it, PushRegistrationPolicy.unwrapFcm(envelope() - it, receipt, now))
        }
    }

    @Test fun cloudRejectsUnboundSevenFieldPayloadAndExtraContent() {
        assertNull(PushRegistrationPolicy.unwrapFcm(native, receipt, now))
        assertNull(PushRegistrationPolicy.unwrapFcm(envelope() + ("body" to "private text"), receipt, now))
        assertNull(PushRegistrationPolicy.unwrapFcm(envelope() + ("phase" to "active"), receipt, now))
        assertNull(PushRegistrationPolicy.unwrapFcm(envelope(), receipt.copy(expiresAt = now), now))
    }

    @Test fun unownedSessionEnvelopeAndOverlongLeaseAreRejected() {
        assertNull(PushRegistrationPolicy.unwrapFcm(envelope() + ("sessionId" to "session-99999999-9999-4999-8999-999999999999"), receipt, now))
        assertNull(PushRegistrationPolicy.unwrapFcm(envelope(), receipt.copy(expiresAt = now + 86_400_001), now))
    }
}
