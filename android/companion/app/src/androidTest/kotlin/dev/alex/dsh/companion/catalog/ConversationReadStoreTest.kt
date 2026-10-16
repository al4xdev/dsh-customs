package dev.alex.dsh.companion.catalog

import android.content.Context
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import dev.alex.dsh.companion.protocol.VisibleAssistantHead
import java.util.UUID
import kotlin.coroutines.CoroutineContext
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/** Dummy namespaces/files only. No vault, owner transport, auth, phone or cloud access. */
@RunWith(AndroidJUnit4::class)
class ConversationReadStoreTest {
    private val context: Context get() = InstrumentationRegistry.getInstrumentation().targetContext
    private val entry = ConversationReadEntry("s1", 1, 4, 8, VisibleAssistantHead(7, "m7", 12, false))
    private fun suffix() = UUID.randomUUID().toString()
    private fun preferenceName(suffix: String) = "${ConversationReadStore.PREFERENCES}_test_$suffix"

    @Test fun restoreReusesNamespaceWhileSuccessfulManualReplacementIsolates() = runBlocking {
        val suffix = suffix()
        val store = ConversationReadStore.forTest(context, Dispatchers.IO, suffix)
        try {
            assertNull(store.bootstrap())
            val first = store.replace()
            assertTrue(store.save(first, listOf(entry)))
            val restored = ConversationReadStore.forTest(context, Dispatchers.IO, suffix)
            assertEquals(first, restored.bootstrap())
            assertEquals(listOf(entry), restored.load(first))
            val replacement = restored.replace()
            assertNotEquals(first, replacement)
            assertTrue(restored.load(replacement).isEmpty())
            assertFalse(store.save(first, listOf(entry.copy(readThrough = 7))))
            assertFalse(store.clear(first))
            assertEquals(replacement, restored.bootstrap())
        } finally {
            withContext(Dispatchers.IO) { context.deleteSharedPreferences(preferenceName(suffix)) }
        }
    }

    @Test fun olderQueuedSnapshotCannotLowerDisplayedReadHighWater() = runBlocking {
        val suffix = suffix()
        val store = ConversationReadStore.forTest(context, Dispatchers.IO, suffix)
        try {
            val namespace = store.replace()
            assertTrue(store.save(namespace, listOf(entry.copy(readThrough = 7))))
            assertTrue(store.save(namespace, listOf(entry)))
            assertEquals(7L, store.load(namespace).single().readThrough)
            assertTrue(store.save(namespace, listOf(entry.copy(createdAt = 2, readThrough = 2))))
            assertTrue(store.save(namespace, listOf(entry)))
            assertEquals(2L, store.load(namespace).single().createdAt)
        } finally {
            withContext(Dispatchers.IO) { context.deleteSharedPreferences(preferenceName(suffix)) }
        }
    }

    @Test fun queuedHydrateAndSaveCannotResurrectAfterLogoutTombstone() = runBlocking {
        val suffix = suffix()
        val dispatcher = PausedDispatcher()
        val store = ConversationReadStore.forTest(context, dispatcher, suffix)
        try {
            val replacement = async(start = CoroutineStart.UNDISPATCHED) { store.replace() }
            dispatcher.drain()
            val namespace = replacement.await()
            val firstSave = async(start = CoroutineStart.UNDISPATCHED) { store.save(namespace, listOf(entry)) }
            dispatcher.drain(); assertTrue(firstSave.await())
            val lateSave = async(start = CoroutineStart.UNDISPATCHED) { store.save(namespace, listOf(entry.copy(readThrough = 7))) }
            val lateLoad = async(start = CoroutineStart.UNDISPATCHED) { store.load(namespace) }
            val logout = async(start = CoroutineStart.UNDISPATCHED) { store.clear(namespace) }
            // Revocation happened before dispatch: even FIFO execution rejects the older queued jobs.
            dispatcher.drain()
            assertFalse(lateSave.await())
            assertTrue(lateLoad.await().isEmpty())
            assertTrue(logout.await())
            val bootstrap = async(start = CoroutineStart.UNDISPATCHED) { store.bootstrap() }
            dispatcher.drain(); assertNull(bootstrap.await())
            assertNull(context.getSharedPreferences(preferenceName(suffix), Context.MODE_PRIVATE).getString(ConversationReadStore.RECORD, null))
        } finally {
            context.deleteSharedPreferences(preferenceName(suffix))
        }
    }

    @Test fun rotationCancelsLateSaveAndBootstrapCannotReAdoptPreviousDiskNonce() = runBlocking {
        val suffix = suffix()
        val dispatcher = PausedDispatcher()
        val store = ConversationReadStore.forTest(context, dispatcher, suffix)
        try {
            val first = async(start = CoroutineStart.UNDISPATCHED) { store.replace() }
            dispatcher.drain(); val old = first.await()
            val save = async(start = CoroutineStart.UNDISPATCHED) { store.save(old, listOf(entry)) }
            val second = async(start = CoroutineStart.UNDISPATCHED) { store.replace() }
            val load = async(start = CoroutineStart.UNDISPATCHED) { store.load(old) }
            val racingBootstrap = async(start = CoroutineStart.UNDISPATCHED) { store.bootstrap() }
            // Run restore before the replacement's disk write: it must not re-adopt the old nonce.
            dispatcher.runLast()
            assertNull(racingBootstrap.await())
            dispatcher.drain()
            assertFalse(save.await()); assertTrue(load.await().isEmpty())
            val current = second.await()
            assertNotEquals(old, current)
            val restored = async(start = CoroutineStart.UNDISPATCHED) { store.bootstrap() }
            dispatcher.drain(); assertEquals(current, restored.await())
        } finally {
            context.deleteSharedPreferences(preferenceName(suffix))
        }
    }

    @Test fun callerCancellationStillPersistsRotationAndLogoutTombstone() = runBlocking {
        val suffix = suffix()
        val dispatcher = PausedDispatcher()
        val store = ConversationReadStore.forTest(context, dispatcher, suffix)
        try {
            val first = async(start = CoroutineStart.UNDISPATCHED) { store.replace() }
            dispatcher.drain(); val old = first.await()
            val cancelledRotation = async(start = CoroutineStart.UNDISPATCHED) { store.replace() }
            cancelledRotation.cancel()
            dispatcher.drain(); cancelledRotation.join()
            val restored = async(start = CoroutineStart.UNDISPATCHED) { store.bootstrap() }
            dispatcher.drain(); val current = restored.await()!!
            assertNotEquals(old, current)
            val cancelledLogout = async(start = CoroutineStart.UNDISPATCHED) { store.clear(current) }
            cancelledLogout.cancel()
            dispatcher.drain(); cancelledLogout.join()
            val afterLogout = async(start = CoroutineStart.UNDISPATCHED) { store.bootstrap() }
            dispatcher.drain(); assertNull(afterLogout.await())
        } finally {
            context.deleteSharedPreferences(preferenceName(suffix))
        }
    }

    @Test fun corruptionResetsOnlyLocalBaselineAndPreservesDedicatedNamespace() = runBlocking {
        val suffix = suffix()
        val store = ConversationReadStore.forTest(context, Dispatchers.IO, suffix)
        try {
            val namespace = store.replace()
            assertTrue(store.save(namespace, listOf(entry)))
            withContext(Dispatchers.IO) {
                context.getSharedPreferences(preferenceName(suffix), Context.MODE_PRIVATE).edit()
                    .putString(ConversationReadStore.RECORD, "{corrupt}").commit()
            }
            assertEquals(namespace, store.bootstrap())
            assertTrue(store.load(namespace).isEmpty())
            val state = ConversationReadState(namespace, store.load(namespace))
            state.observe(namespace, dev.alex.dsh.companion.protocol.ConversationMessageHead("s1", 1,
                dev.alex.dsh.companion.protocol.NativeKnowledge.CURRENT, 8, entry.head))
            assertFalse(state.isUnread("s1"))
            assertTrue(store.save(namespace, state.snapshot()))
            assertEquals(7L, store.load(namespace).single().readThrough)
        } finally {
            withContext(Dispatchers.IO) { context.deleteSharedPreferences(preferenceName(suffix)) }
        }
    }

    private class PausedDispatcher : CoroutineDispatcher() {
        private val queue = ArrayDeque<Runnable>()
        override fun dispatch(context: CoroutineContext, block: Runnable) { queue.addLast(block) }
        fun drain() { while (queue.isNotEmpty()) queue.removeFirst().run() }
        fun runLast() { queue.removeLast().run() }
    }
}
