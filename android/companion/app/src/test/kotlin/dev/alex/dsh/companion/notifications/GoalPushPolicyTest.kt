package dev.alex.dsh.companion.notifications

import org.junit.Assert.*
import org.junit.Test

class GoalPushPolicyTest {
    private val now = 1_800_000_000_000L
    private val sid = "session-11111111-1111-4111-8111-111111111111"
    private val goal = "goal-22222222-2222-4222-8222-222222222222"
    private val epoch = "33333333-3333-4333-8333-333333333333"
    private val nonce = "44444444-4444-4444-8444-444444444444"
    private val native = mapOf("version" to "1", "eventId" to "a".repeat(64), "sessionId" to sid,
        "goalId" to goal, "revision" to "7", "phase" to "completed", "timestamp" to now.toString())
    private val authority = NotificationAuthority(epoch, 12L, setOf(sid))
    private fun push(data: Map<String, String> = native) = requireNotNull(GoalCompletionPush.parse(data, now))
    private fun reserve() = requireNotNull(GoalPushPolicy.reserve(emptyList(), push(), authority, now, nonce))

    @Test fun rawNotificationExtrasCannotBypassDataOnlyPolicyInBackground() {
        assertTrue(GoalPushIntentPolicy.isDataOnly(native.keys + setOf("google.message_id", "from")))
        listOf("gcm.n.e", "gcm.n.body", "gcm.notification.e", "gcm.notification.title", "notification").forEach {
            assertFalse(it, GoalPushIntentPolicy.isDataOnly(native.keys + it))
        }
    }

    @Test fun acceptsOnlyMinimalNativeCompletion() {
        val dto = push()
        assertEquals(sid, dto.sessionId)
        assertEquals(goal, dto.goalId)
        assertEquals(7L, dto.revision)
    }

    @Test fun rejectsContentAndUnknownFields() {
        listOf("title", "body", "objective", "path", "token", "notification", "session", "type").forEach {
            assertNull(it, GoalCompletionPush.parse(native + (it to "private"), now))
        }
    }

    @Test fun rejectsEveryMissingField() {
        native.keys.forEach { assertNull(it, GoalCompletionPush.parse(native - it, now)) }
    }

    @Test fun rejectsNonCompletionOrWrongVersion() {
        listOf("active", "paused", "complete", "blocked", "COMPLETED", "").forEach {
            assertNull(GoalCompletionPush.parse(native + ("phase" to it), now))
        }
        assertNull(GoalCompletionPush.parse(native + ("version" to "2"), now))
    }

    @Test fun validatesNativeIdentityWithoutPathsOrUris() {
        listOf("../../private", "https://owner/private", "session-not-native", sid.uppercase(), "$sid/child", "").forEach {
            assertNull(GoalCompletionPush.parse(native + ("sessionId" to it), now))
        }
        assertNull(GoalCompletionPush.parse(native + ("goalId" to sid), now))
    }

    @Test fun rejectsBadEventDigest() {
        listOf("a".repeat(63), "A".repeat(64), "x".repeat(64), "a".repeat(129), "").forEach {
            assertNull(GoalCompletionPush.parse(native + ("eventId" to it), now))
        }
    }

    @Test fun boundsRevisionAndTimestampStrictly() {
        listOf("0", "-1", "01", "1.0", "1e3", " 1", "9007199254740992", Long.MAX_VALUE.toString()).forEach {
            assertNull(GoalCompletionPush.parse(native + ("revision" to it), now))
        }
        assertNull(GoalCompletionPush.parse(native + ("timestamp" to (now - GoalCompletionPush.MAX_AGE_MS - 1).toString()), now))
        assertNull(GoalCompletionPush.parse(native + ("timestamp" to (now + GoalCompletionPush.FUTURE_SKEW_MS + 1).toString()), now))
        assertNotNull(GoalCompletionPush.parse(native + ("timestamp" to (now - GoalCompletionPush.MAX_AGE_MS).toString()), now))
    }

    @Test fun unknownOwnerAndGenerationDoNotAuthorizePush() {
        assertNull(GoalPushPolicy.reserve(emptyList(), push(), null, now, nonce))
        assertNull(GoalPushPolicy.reserve(emptyList(), push(), authority.copy(sessionIds = emptySet()), now, nonce))
    }

    @Test fun replayAndCrossTransportShareOneLedger() {
        val saved = reserve()
        assertNull(GoalPushPolicy.reserve(saved, push(), authority, now, nonce))
        assertNull(GoalPushPolicy.reserve(saved, push(native + ("eventId" to "b".repeat(64))), authority, now, nonce))
    }

    @Test fun completedRevisionsRemainDistinct() {
        val second = push(native + mapOf("revision" to "8", "eventId" to "b".repeat(64)))
        assertEquals(2, GoalPushPolicy.reserve(reserve(), second, authority, now, epoch)?.size)
    }

    @Test fun durableCodecPreservesReplayBarrierAcrossRestart() {
        val restored = requireNotNull(GoalReceiptCodec.decode(GoalReceiptCodec.encode(reserve())))
        assertEquals(reserve(), restored)
        assertNull(GoalPushPolicy.reserve(restored, push(), authority, now, nonce))
        assertNull(GoalPushPolicy.tap(restored, nonce, null, now))
    }

    @Test fun boundedSaturationDoesNotEvictUnexpiredReplayKeys() {
        val full = List(GoalPushPolicy.MAX_RECEIPTS) { index -> reserve().single().copy(eventId = index.toString(16).padStart(64, '0'), revision = index + 100L) }
        assertNull(GoalPushPolicy.reserve(full, push(), authority, now, nonce))
        val expired = full.map { it.copy(expiresAt = now - 1) }
        assertEquals(1, GoalPushPolicy.reserve(expired, push(), authority, now, nonce)?.size)
    }

    @Test fun corruptedStoreFailsClosedRatherThanResettingDedup() {
        assertNull(GoalReceiptCodec.decode(setOf("malformed")))
        val valid = GoalReceiptCodec.encode(reserve()).single()
        assertNull(GoalReceiptCodec.decode(setOf(valid.replace(epoch, "invalid"))))
        assertNull(GoalReceiptCodec.decode(setOf(valid.replace("|7|", "|0|"))))
        assertNull(GoalReceiptCodec.decode(setOf(valid + "|extra")))
        assertNull(GoalReceiptCodec.decode(setOf(valid, valid.replace("a".repeat(64), "b".repeat(64)))))
    }

    @Test fun tapRequiresMintedNonceFreshOwnershipAndSameAuthorizationEpoch() {
        val saved = reserve()
        assertNotNull(GoalPushPolicy.tap(saved, nonce, authority, now))
        assertNull(GoalPushPolicy.tap(saved, epoch, authority, now))
        assertNull(GoalPushPolicy.tap(saved, nonce, authority.copy(epoch = nonce), now))
        assertNull(GoalPushPolicy.tap(saved, nonce, authority.copy(sessionIds = emptySet()), now))
        assertNull(GoalPushPolicy.tap(saved, nonce, authority, now + GoalCompletionPush.MAX_AGE_MS + GoalCompletionPush.FUTURE_SKEW_MS + 1))
        assertNull(GoalPushPolicy.tap(saved.map { it.copy(tapped = true) }, nonce, authority, now))
    }

    @Test fun permissionDenialOptOutChannelOffAndAuthLossBlockBothSources() {
        val enabled = PushUiStatus(configured = true, optedIn = true, permissionGranted = true,
            channelEnabled = true, authorizationReady = true, registrationReady = true)
        val denied = listOf(enabled.copy(optedIn = false), enabled.copy(permissionGranted = false),
            enabled.copy(channelEnabled = false), enabled.copy(authorizationReady = false))
        denied.forEach { state -> GoalPushSource.entries.forEach { assertFalse(GoalDeliveryGate.allowed(state, it)) } }
        GoalPushSource.entries.forEach { assertTrue(GoalDeliveryGate.allowed(enabled, it)) }
    }

    @Test fun localNativeCanNotifyOfflineButUnconfiguredCloudCannot() {
        val local = PushUiStatus(optedIn = true, permissionGranted = true, channelEnabled = true, authorizationReady = true)
        assertTrue(GoalDeliveryGate.allowed(local, GoalPushSource.LIVE_NATIVE))
        assertFalse(GoalDeliveryGate.allowed(local, GoalPushSource.FCM))
        assertFalse(GoalDeliveryGate.allowed(local.copy(configured = true), GoalPushSource.FCM))
    }
}
