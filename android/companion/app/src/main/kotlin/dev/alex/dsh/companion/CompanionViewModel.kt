package dev.alex.dsh.companion

import android.app.Application
import android.graphics.Bitmap
import android.net.Uri
import dev.alex.dsh.companion.files.SelectedUploadFile
import dev.alex.dsh.companion.files.FilePickerTicket
import dev.alex.dsh.companion.files.FileTransferFailure
import dev.alex.dsh.companion.files.readPickedUploadFile
import dev.alex.dsh.companion.files.validateSelectedUploads
import dev.alex.dsh.companion.delivery.SubmittedFileEvidence
import dev.alex.dsh.companion.net.OwnerOrigin
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import dev.alex.dsh.companion.delivery.SubmissionLedger
import dev.alex.dsh.companion.delivery.PreparationGate
import dev.alex.dsh.companion.delivery.AppModelPreflightFailure
import dev.alex.dsh.companion.delivery.requireCurrentAppModel
import dev.alex.dsh.companion.delivery.NewChatDraftController
import dev.alex.dsh.companion.delivery.ResponseActivity
import dev.alex.dsh.companion.delivery.ForegroundInteractions
import dev.alex.dsh.companion.delivery.QuestionProjectionFence
import dev.alex.dsh.companion.delivery.QuestionResponseLedger
import dev.alex.dsh.companion.delivery.InteractionViewport
import dev.alex.dsh.companion.delivery.AnswererReconnectPolicy
import dev.alex.dsh.companion.delivery.NativeGoalPermitAge
import dev.alex.dsh.companion.delivery.questionAcknowledgement
import dev.alex.dsh.companion.catalog.ConversationAttention
import dev.alex.dsh.companion.catalog.ConversationReadNamespace
import dev.alex.dsh.companion.catalog.ConversationReadState
import dev.alex.dsh.companion.catalog.ConversationReadStore
import dev.alex.dsh.companion.catalog.MetadataLease
import dev.alex.dsh.companion.catalog.CatalogInvalidationClock
import dev.alex.dsh.companion.catalog.HostObservation
import dev.alex.dsh.companion.catalog.hasInteractionCheckHint
import dev.alex.dsh.companion.catalog.hostStatusLabel
import dev.alex.dsh.companion.net.OwnerTransport
import dev.alex.dsh.companion.net.OwnerPushRegistrationClient
import dev.alex.dsh.companion.net.OwnerCookieJar
import dev.alex.dsh.companion.net.EncryptedOwnerCookieStore
import dev.alex.dsh.companion.net.CookieStoreFailure
import dev.alex.dsh.companion.net.TransportFailure
import dev.alex.dsh.companion.net.DecodedSocketFrame
import dev.alex.dsh.companion.net.SocketIngress
import dev.alex.dsh.companion.protocol.*
import dev.alex.dsh.companion.media.ImageFailure
import dev.alex.dsh.companion.media.OwnedImageCache
import dev.alex.dsh.companion.render.ImageReference
import dev.alex.dsh.companion.render.RenderBlock
import dev.alex.dsh.companion.render.TranscriptPresenter
import dev.alex.dsh.companion.render.TranscriptSource
import dev.alex.dsh.companion.render.TranscriptStamp
import dev.alex.dsh.companion.ui.*
import dev.alex.dsh.companion.ui.settings.*
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import dev.alex.dsh.companion.notifications.GoalNotifications
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.job
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.flow.first
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.JsonNull
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

class CompanionViewModel(application: Application) : AndroidViewModel(application), UiActions {
    private val transport = OwnerTransport(OwnerCookieJar(EncryptedOwnerCookieStore(application)))
    private val displayPreferences = DisplayPreferences(application)
    private val mutable = MutableStateFlow(CompanionUiState(initializing = true,
        showModelContext = displayPreferences.showModelContext()))
    val state = mutable.asStateFlow()
    private var generation = 0L
    private var catalogSerial = 0L
    private var modelCatalogSerial = 0L
    private val deleteUncertainIds = mutableSetOf<String>()
    private var pendingDefaultModel: ModelChoice? = null
    private var previousDefaultModel: ModelChoice? = null
    private var socket: WebSocket? = null
    private var socketSerial = 0L
    private var opening = false
    private var eventsReady = false
    private var eventStream = ""
    private var followStream = ""
    private var admitted: AdmittedChat? = null
    private var journal: SessionJournal? = null
    private var assistant = AssistantAssembler()
    private val interactions = ForegroundInteractions()
    private val approvals get() = interactions.approvals
    private val questions get() = interactions.questions
    private val admissionJobs = mutableMapOf<String, Job>()
    private val interactionCalls = mutableSetOf<Job>()
    private val admissionConcurrency = Semaphore(4)
    private val questionProjection = QuestionProjectionFence()
    private val questionReplies = QuestionResponseLedger()
    private val displayedContinuedQuestions = mutableSetOf<UserQuestionKey>()
    private var questionProjectionJob: Job? = null
    private var questionProjectionRequested = false
    private var answererVisibilityJob: Job? = null
    private val answererRetry = AnswererReconnectPolicy()
    private val historyWindow = HistoryPageWindow()
    private var answererRetryJob: Job? = null
    // A rotation disposes the old composition before the new one claims the workspace.
    private var workspaceRecreating = false
    // The live assistant preview hit a limit/new vocabulary; the durable journal still renders.
    private var assistantLiveDegraded = false
    private val goalPermits = NativeGoalPermitAge()
    private var selectedOpenJob: Job? = null
    private data class TimedQuestionClaim(val streamId: String, val capability: UserQuestionAttachment, var timer: Job? = null)
    private val timedClaims = mutableMapOf<String, TimedQuestionClaim>()
    private val drafts = mutableMapOf<String, String>()
    private val newChatDraft = NewChatDraftController()
    private data class FirstDraft(val ticket: NewChatDraftController.Ticket, val generation: Long, val sessionId: String? = null, val files: FileSendIntent? = null)
    private class FileSendIntent(val draft: UploadDraftIdentity, val files: List<SelectedUploadFile>, val literal: String,
        val requestId: String, var epoch: Long, var sessionId: String?, var createdAt: Long?) {
        @Volatile var active = true
        @Volatile var uploadStarted = false
        var promptAttempted = false
        override fun toString(): String = "FileSendIntent(redacted)"
    }
    private var fileDraftId = id()
    private var fileRouteId: String? = null
    private var fileRouteCreatedAt: Long? = null
    private var selectedFiles = emptyList<SelectedUploadFile>()
    private var filesNeedReselect = false
    private var pickerTicket: FilePickerTicket? = null
    private var fileMetadataJob: Job? = null
    private var activeFileSend: FileSendIntent? = null
    private var fileSendJob: Job? = null
    private val fileRequestSelections = mutableMapOf<String, List<String>>()
    private var firstDraft: FirstDraft? = null
    private val openings = OpeningCheckpoint()
    private val submissions = SubmissionLedger()
    private val preparations = PreparationGate()
    private val responses = ResponseActivity()
    private val consumedDrafts = mutableSetOf<String>()
    private val images = OwnedImageCache()
    private val imageDecode = Semaphore(1)
    private var ingress: SocketIngress? = null
    private var presenter: TranscriptPresenter? = null
    private var latestPresentation: TranscriptStamp? = null
    private var presentedRecordsRevision = -1L
    private val projectionChanges = MutableStateFlow(0L)
    private val nativeGoalOnce = NativeGoalOnce()
    private var nativeReadSerial = 0L
    private var nativeReadJob: Job? = null
    private var activityLoop: Job? = null
    private var metadataJob: Job? = null
    private var metadataCatalogJob: Job? = null
    private var metadataCatalogSerial = -1L
    private var metadataLease: MetadataLease? = null
    private var metadataSerial = 0L
    private var catalogInvalidation = CatalogInvalidationClock()
    private val hostObservation = HostObservation()
    private var hostActivityNeedsRead = false
    private var interactionHeads = emptyMap<String, InteractionHead>()
    private var interactionHeadsViewportEpoch = -1L
    private var catalogViewportDebounce: Job? = null
    private data class CatalogViewportSource(val sessionId: String, val createdAt: Long)
    private var activeCatalogViewport = emptyList<CatalogViewportSource>()
    private var activeViewportEpoch = -1L
    private var activitySerial = 0L
    private var authGeneration = 0L
    private var ownedSessionIds = emptySet<String>()
    private var pushRegistrationPreparing = false
    private var pushExplicitlyDisabled = false
    private val uiLifecycle = CompanionActivityLifecycle()
    private val foregroundReads = mutableSetOf<Job>()
    private var initialRestorePending = true
    private var restoreOnStart = false
    private var restoreJob: Job? = null
    private var resumeSelectedOnStart = false
    private var refreshCatalogOnStart = false
    private val readStore = ConversationReadStore(application)
    private val readBinding = Mutex()
    private var readScopeAuthEpoch = 0L
    private var readNamespace: ConversationReadNamespace? = null
    private var conversationReads: ConversationReadState? = null
    private var messageHeadsSerial = 0L
    private var readPersistSerial = 0L
    private var readPersistJob: Job? = null

    /** Revoke synchronously; serialized disk work may finish, but cannot publish into a new account. */
    private fun revokeReadAuthority(): Pair<Long, ConversationReadNamespace?> {
        stopForegroundMetadata()
        clearFileDraft()
        val previous = readNamespace
        readScopeAuthEpoch++
        questionReplies.clear()
        messageHeadsSerial++
        readPersistSerial++
        readNamespace = null
        conversationReads = null
        mutable.update { it.copy(chatUnread = emptySet()) }
        return readScopeAuthEpoch to previous
    }

    private suspend fun awaitReadForeground(epoch: Long): Boolean {
        state.first { uiLifecycle.started || epoch != readScopeAuthEpoch }
        return uiLifecycle.started && epoch == readScopeAuthEpoch
    }

    private suspend fun bindReadAuthority(epoch: Long, replace: Boolean): Boolean {
        try {
            return readBinding.withLock {
                if (!awaitReadForeground(epoch)) return@withLock false
                val restoredScope = if (replace) null else readStore.bootstrap()
                if (!awaitReadForeground(epoch)) return@withLock false
                val scope = restoredScope ?: readStore.replace()
                if (!awaitReadForeground(epoch)) return@withLock false
                val restored = readStore.load(scope)
                if (!awaitReadForeground(epoch)) return@withLock false
                readNamespace = scope
                conversationReads = ConversationReadState(scope, restored).also { it.setResumed(uiLifecycle.resumed) }
                publishUnread()
                true
            }
        } catch (error: Exception) {
            if (error is CancellationException) throw error
            if (epoch != readScopeAuthEpoch) return false
            // Marker storage is optional: its failure must not deny a separately validated login.
            readNamespace = null
            conversationReads = null
            mutable.update { it.copy(chatUnread = emptySet()) }
            return true
        }
    }

    private suspend fun clearReadAuthority(epoch: Long, previous: ConversationReadNamespace?) {
        try {
            readBinding.withLock {
                if (epoch != readScopeAuthEpoch) return@withLock
                val scope = previous ?: readStore.bootstrap()
                if (epoch != readScopeAuthEpoch) return@withLock
                if (scope != null) readStore.clear(scope)
            }
        } catch (error: Exception) {
            if (error is CancellationException) throw error
            // The account has already lost RAM authority; a marker failure cannot block forgetting login.
        }
    }

    private fun publishUnread() {
        val reads = conversationReads
        val unread = if (reads != null && uiLifecycle.resumed && catalogObservationActive()) {
            val lifecycles = reads.snapshot().associate { it.sessionId to it.createdAt }
            state.value.chats.asSequence().filter { chat ->
                chat.id in ownedSessionIds && chat.createdAt != null && lifecycles[chat.id] == chat.createdAt && reads.isUnread(chat.id)
            }.map { it.id }.toSet()
        } else emptySet()
        mutable.update { it.copy(chatUnread = unread) }
    }

    private fun invalidateMessageHeads() {
        messageHeadsSerial++
        val scope = readNamespace
        if (scope != null) conversationReads?.let { it.unavailable(scope, it.snapshot().map { row -> row.sessionId }) }
        mutable.update { it.copy(chatUnread = emptySet()) }
    }

    /** One commit lane coalesces newer acknowledgements; cancellation is not a disk rollback. */
    private fun persistReadState() {
        readPersistSerial++
        if (!uiLifecycle.started || readPersistJob?.isActive == true || conversationReads == null) return
        readPersistJob = viewModelScope.launch {
            val owner = currentCoroutineContext().job
            val authority = readScopeAuthEpoch
            try {
                while (uiLifecycle.started) {
                    val serial = readPersistSerial
                    val epoch = readScopeAuthEpoch
                    val scope = readNamespace ?: return@launch
                    val reads = conversationReads ?: return@launch
                    readBinding.withLock {
                        if (epoch == readScopeAuthEpoch && readNamespace == scope && conversationReads === reads && uiLifecycle.started) {
                            check(readStore.save(scope, reads.snapshot())) { "read-store-write-failed" }
                        }
                    }
                    if (serial == readPersistSerial || epoch != readScopeAuthEpoch) return@launch
                }
            } catch (error: Exception) {
                if (error is CancellationException) throw error
                // An old account's failed commit must not withdraw a newer account's observations.
                if (authority == readScopeAuthEpoch) invalidateMessageHeads()
            } finally {
                if (readPersistJob === owner) {
                    readPersistJob = null
                    if (authority != readScopeAuthEpoch && uiLifecycle.started && conversationReads != null) persistReadState()
                }
            }
        }
    }

    fun setAppVisibility(started: Boolean, resumed: Boolean) {
        val changed = uiLifecycle.appVisibility(started, resumed)
        conversationReads?.setResumed(uiLifecycle.resumed)
        mutable.update { it.copy(appStarted = uiLifecycle.started, appResumed = uiLifecycle.resumed) }
        publishUnread()
        if (!uiLifecycle.resumed) closeTimedClaims()
        if (!uiLifecycle.resumed) {
            stopForegroundMetadata()
            stopActivityReconciliation()
        } else {
            startForegroundMetadata()
            startActivityReconciliation()
        }
        if (!changed) return
        if (!started) {
            if (fileMetadataJob != null) {
                fileMetadataJob?.cancel(); fileMetadataJob = null
                mutable.update { it.copy(filePickerPending = pickerTicket != null) }
            }
            answererVisibilityJob?.cancel(); answererVisibilityJob = null
            answererRetryJob?.cancel(); answererRetryJob = null
            stopActivityReconciliation()
            nativeReadSerial++
            nativeReadJob?.cancel(); nativeReadJob = null
            restoreOnStart = restoreJob?.isActive == true
            val hadReads = foregroundReads.isNotEmpty()
            refreshCatalogOnStart = hadReads && state.value.authenticated && !state.value.hasOpenConversation
            if (state.value.hasOpenConversation) {
                state.value.selectedId?.let { drafts[it] = state.value.draft }
                if (state.value.isNewDraft) newChatDraft.edit(state.value.draft)
                resumeSelectedOnStart = state.value.selectedId != null
                val peer = socket
                // A UI suspension is not a server cancellation or push-authority revocation.
                resetConnection()
                peer?.cancel()
                mutable.update { it.copy(connected = false, busy = false, approvals = emptyList(),
                    streamingText = null, presentationPending = false,
                    richMessages = it.richMessages.map { message ->
                        if (message.streaming) message.copy(streaming = false, interrupted = true) else message
                    }, status = "Conversa suspensa", error = null) }
                updateDelivery()
            } else {
                // The catalog owns a real foreground answerer too, not an unbounded background observer.
                if (socket != null || opening || eventsReady) resetConnection()
                if (hadReads || restoreOnStart) {
                    catalogSerial++
                    modelCatalogSerial++
                    mutable.update { it.copy(busy = false, settings = it.settings.copy(loading = false)) }
                }
            }
            // The bridge cancels only each owned read Call, never admitted human mutations.
            foregroundReads.toList().forEach { it.cancel() }
            if (restoreOnStart) restoreJob?.cancel()
            return
        }
        // Returning to the foreground is a fresh start for the automatic reopen ladder.
        answererRetry.reset()
        if (initialRestorePending) {
            initialRestorePending = false
            restoreLogin(initial = true)
        } else if (restoreOnStart) {
            restoreOnStart = false
            restoreLogin(initial = false)
        } else if (resumeSelectedOnStart) {
            resumeSelectedOnStart = false
            if (state.value.authenticated && state.value.selectedId != null) reconnect()
        } else if (refreshCatalogOnStart ||
            state.value.authenticated && state.value.chats.isEmpty() && !state.value.hasOpenConversation) {
            refreshCatalogOnStart = false
            refresh()
        }
        startActivityReconciliation()
        reconcileAnswererVisibility()
        persistReadState()
    }

    /** MainActivity only, from onStop during a configuration change: the UI is recreated, not hidden. */
    fun holdWorkspaceForRecreation() { workspaceRecreating = true }

    override fun setWorkspaceVisibility(owner: Any, catalogVisible: Boolean, conversationVisible: Boolean) {
        workspaceRecreating = false
        if (uiLifecycle.claimWorkspace(owner)) stopActivityReconciliation()
        setCatalogVisible(catalogVisible)
        setConversationVisible(conversationVisible)
        reconcileAnswererVisibility()
    }

    override fun clearWorkspaceVisibility(owner: Any) {
        if (workspaceRecreating) {
            // Keep pane visibility, so the answerer and an in-flight send survive until the
            // recreated composition claims the workspace again (which clears this flag).
            uiLifecycle.releaseWorkspace(owner)
            return
        }
        if (!uiLifecycle.releaseWorkspace(owner)) return
        stopActivityReconciliation()
        setCatalogVisible(false)
        setConversationVisible(false)
        reconcileAnswererVisibility()
    }

    override fun setCatalogVisible(visible: Boolean) {
        if (!uiLifecycle.catalogVisibility(visible)) return
        if (visible) startActivityReconciliation() else stopActivityReconciliation()
        startForegroundMetadata()
        reconcileAnswererVisibility()
    }

    override fun setCatalogViewport(owner: Any, sessionIds: List<String>) {
        if (!uiLifecycle.ownsWorkspace(owner)) return
        val headers = state.value.chats.associateBy { it.id }
        val proven = sessionIds.asSequence().distinct().filter { id ->
            id in ownedSessionIds && headers[id]?.createdAt != null
        }.take(CompanionActivityLifecycle.MAX_VIEWPORT_IDS).toList()
        if (!uiLifecycle.catalogViewport(owner, proven)) return
        // Withdraw the previous source immediately, but coalesce scroll/layout changes before IO.
        stopActivityReconciliation()
        if (!catalogObservationActive() || proven.isEmpty()) return
        val viewportEpoch = uiLifecycle.viewportEpoch
        val foreground = uiLifecycle.foregroundEpoch
        catalogViewportDebounce = viewModelScope.launch {
            val job = currentCoroutineContext().job
            try {
                delay(120)
                if (catalogViewportDebounce !== job) return@launch
                catalogViewportDebounce = null
                if (uiLifecycle.acceptsViewport(owner, viewportEpoch, foreground) && catalogObservationActive()) startActivityReconciliation()
            } finally {
                if (catalogViewportDebounce === job) catalogViewportDebounce = null
            }
        }
    }

    private fun currentCatalogViewport(): List<CatalogViewportSource> {
        val headers = state.value.chats.associateBy { it.id }
        val proven = headers.values.filter { it.id in ownedSessionIds && it.createdAt != null }.map { it.id }.toSet()
        return uiLifecycle.eligibleCatalogViewport(proven).map { id ->
            CatalogViewportSource(id, requireNotNull(headers.getValue(id).createdAt))
        }
    }

    private fun catalogViewportCurrent(viewport: List<CatalogViewportSource>, epoch: Long): Boolean =
        viewport.isNotEmpty() && uiLifecycle.viewportEpoch == epoch && catalogObservationActive() && currentCatalogViewport() == viewport

    override fun setConversationVisible(visible: Boolean) {
        if (!uiLifecycle.conversationVisibility(visible)) return
        if (visible) refreshNativeGoals() else {
            nativeReadSerial++
            nativeReadJob?.cancel(); nativeReadJob = null
            mutable.update { it.copy(nativeGoals = it.nativeGoals.copy(control = null)) }
        }
        if (!visible) closeTimedClaims()
        reconcileAnswererVisibility()
    }

    private fun interactionViewport() = InteractionViewport(uiLifecycle.started, uiLifecycle.resumed, state.value.authenticated,
        uiLifecycle.catalogVisible, uiLifecycle.conversationVisible, state.value.selectedId, state.value.connected, interactions.ready)

    private fun answererVisible(): Boolean = interactionViewport().answererActive

    private fun reconcileAnswererVisibility() {
        answererVisibilityJob?.cancel()
        answererVisibilityJob = viewModelScope.launch {
            // Workspace setters change both panes in one publication; do not react to an intermediate pane.
            kotlinx.coroutines.yield()
            if (!answererVisible()) {
                if (socket != null || opening || eventsReady) {
                    suspendAnswerer()
                }
                return@launch
            }
            if (socket != null || opening) return@launch
            val selected = state.value.selectedId
            if (selected != null && admitted == null) {
                if (!state.value.busy) select(selected)
            } else openSocket(generation, admitted)
        }
    }

    private fun catalogObservationActive(): Boolean =
        uiLifecycle.resumed && uiLifecycle.catalogActive(state.value.authenticated, state.value.hasOpenConversation)

    private fun stopActivityReconciliation() {
        activitySerial++
        invalidateMessageHeads()
        catalogViewportDebounce?.cancel(); catalogViewportDebounce = null
        activityLoop?.cancel(); activityLoop = null
        activeCatalogViewport = emptyList()
        activeViewportEpoch = -1L
        interactionHeads = emptyMap()
        interactionHeadsViewportEpoch = -1L
        mutable.update { it.copy(chatActivity = emptyMap(), interactionCheckHints = emptySet()) }
    }

    private fun bindNotificationAuthority(ids: Set<String>, forceNewGeneration: Boolean = false) {
        if (ids != ownedSessionIds || authGeneration <= 0 || forceNewGeneration) {
            stopActivityReconciliation()
            GoalNotifications.revoke(getApplication())
            authGeneration = try { GoalNotifications.nextAuthorizationGeneration(getApplication()) } catch (_: Exception) { 0L }
        }
        ownedSessionIds = ids.toSet()
        publishUnread()
        if (authGeneration > 0 && !pushExplicitlyDisabled) GoalNotifications.authorize(getApplication(), authGeneration, ownedSessionIds)
        else GoalNotifications.revoke(getApplication())
        if (state.value.authenticated) startActivityReconciliation()
        startForegroundMetadata()
    }

    private fun revokeNotificationAuthority() {
        authGeneration = 0
        ownedSessionIds = emptySet()
        stopActivityReconciliation()
        GoalNotifications.revoke(getApplication())
    }

    /** Extras never grant membership, authenticate, resume a goal, or bypass detail admission. */
    fun openNotificationSession(sessionId: String, generation: Long) {
        if (generation != authGeneration || !state.value.authenticated || sessionId !in ownedSessionIds || state.value.busy) return
        select(sessionId)
    }

    /** Called ONLY by MainActivity after the human opt-in/permission action, never restore/reconnect. */
    fun registerPushNotifications() {
        if (!state.value.authenticated || state.value.busy || pushRegistrationPreparing || ownedSessionIds.isEmpty()) return
        if (!GoalNotifications.status.value.optedIn || !GoalNotifications.status.value.permissionGranted) return
        pushExplicitlyDisabled = false
        pushRegistrationPreparing = true
        val epoch = generation
        val serial = ++catalogSerial
        viewModelScope.launch {
            try {
                // Token rotation needs fresh native ownership and a strictly newer persistent epoch.
                // This bounded metadata listing never follows or reads every conversation's head.
                val ids = linkedSetOf<String>()
                val cursors = mutableSetOf<String>()
                var cursor: String? = null
                do {
                    val rpcId = id()
                    val page = NativeCodec.catalog(unary("companion/listChats", rpcId, NativeRequests.catalog(rpcId, 100, cursor)))
                    if (epoch != generation || serial != catalogSerial || !state.value.authenticated) return@launch
                    page.chats.forEach { check(ids.add(it.id)) { "push-catalog-duplicate" } }
                    check(ids.size <= 4096) { "push-catalog-limit" }
                    cursor = page.nextCursor
                    if (cursor != null) check(cursors.add(cursor) && cursors.size <= 128) { "push-catalog-no-progress" }
                } while (cursor != null)
                if (ids.isEmpty()) { revokeNotificationAuthority(); return@launch }
                bindNotificationAuthority(ids, forceNewGeneration = GoalNotifications.status.value.needsReauthorization || !GoalNotifications.status.value.authorizationReady)
                val auth = authGeneration
                if (auth <= 0) return@launch
                val client = OwnerPushRegistrationClient(rpc = { method, envelope ->
                    if (auth != authGeneration || !state.value.authenticated) throw CancellationException("push-authority-changed")
                    try { withContext(Dispatchers.IO) { transport.rpc(method, envelope) } }
                    catch (error: Exception) {
                        if (error is TransportFailure && error.kind == TransportFailure.Kind.AUTH_REQUIRED) failure(error, generation)
                        throw error
                    }
                })
                GoalNotifications.registerDevice(getApplication(), auth, client)
            } catch (error: Exception) {
                if (error is CancellationException) throw error
                if (epoch == generation && error is TransportFailure && error.kind == TransportFailure.Kind.AUTH_REQUIRED) failure(error, epoch)
            } finally { pushRegistrationPreparing = false }
        }
    }

    fun disablePushNotifications() {
        val request = GoalNotifications.prepareUnregistration(getApplication())
        pushExplicitlyDisabled = true
        GoalNotifications.setOptIn(getApplication(), false)
        GoalNotifications.revoke(getApplication()) // deny locally even if the durable preference write failed
        viewModelScope.launch { unregisterNativePush(request) }
    }

    private suspend fun unregisterNativePush(request: dev.alex.dsh.companion.notifications.PushUnregistrationRequest?) {
        if (request == null || !transport.hasLogin()) return
        try {
            kotlinx.coroutines.withTimeoutOrNull(3000) {
                OwnerPushRegistrationClient(rpc = { method, envelope ->
                    check(method == "goalPush/unregister")
                    withContext(Dispatchers.IO) { transport.unregisterPush(envelope) }
                }).unregister(request)
            }
        } catch (error: Exception) {
            if (error is CancellationException) throw error
            // Offline native cleanup has no replay. Local denial is already immediate; server lease expires.
        }
    }

    override suspend fun loadImage(reference: ImageReference, preview: Boolean): Bitmap {
        val proof = admitted ?: throw ImageFailure("image-not-admitted")
        val epoch = generation
        fun current(): Boolean = epoch == generation && admitted === proof &&
            proof.admission.generation == epoch && state.value.authenticated && state.value.selectedId == proof.chat.id
        fun knownNow(): Boolean = state.value.richMessages.any { message ->
            (message.blocks + message.tool?.content.orEmpty()).any { it is RenderBlock.Image && it.reference == reference }
        }
        suspend fun requireKnown() {
            // A pending presentation must not authorize an image withdrawn by a newer native source.
            // Wait rather than turning ordinary source churn into a persistent thumbnail error.
            projectionChanges.first { !current() || presentedRecordsRevision == journal?.recordsRevision() }
            if (!current() || !knownNow()) throw ImageFailure("image-not-admitted")
        }
        requireKnown()
        val fingerprint = "${reference.mediaType}|${reference.bytes}|${reference.width}|${reference.height}"
        val key = OwnedImageCache.Key(proof.chat.id, epoch, reference.attachmentId, preview, fingerprint)
        images.get(key)?.let { return it }
        return imageDecode.withPermit {
            requireKnown()
            images.get(key)?.let { return@withPermit it }
            try {
                val bitmap = withContext(Dispatchers.IO) {
                    val metadata = ImageAttachmentMetadata(reference.attachmentId, reference.mediaType, reference.bytes,
                        reference.width, reference.height, reference.name)
                    OwnedImageCache.decode(transport.attachment(proof.admission, id(), metadata), preview)
                }
                requireKnown()
                images.put(key, bitmap)
                bitmap
            } catch (error: Exception) {
                if (error is TransportFailure && error.kind == TransportFailure.Kind.AUTH_REQUIRED) failure(error, epoch)
                throw error
            }
        }
    }

    override fun restoreLogin() = restoreLogin(initial = false)

    private fun restoreLogin(initial: Boolean) {
        if (!uiLifecycle.started) return
        if (state.value.busy || state.value.authenticated) return
        val readEpoch = revokeReadAuthority().first
        revokeNotificationAuthority()
        resetConnection()
        val epoch = generation
        mutable.update { it.copy(busy = true, error = null, status = "Verificando login salvo") }
        restoreJob = viewModelScope.launch {
            restoringStartup(initial, { epoch == generation }, {
                mutable.update { it.copy(initializing = false) }
            }) {
                try {
                    val restored = withContext(Dispatchers.IO) { transport.restoreLogin() }
                    if (epoch != generation) return@restoringStartup
                    if (!restored) {
                        mutable.update { CompanionUiState(showModelContext = it.showModelContext,
                            appStarted = uiLifecycle.started, appResumed = uiLifecycle.resumed) }
                        return@restoringStartup
                    }
                    mutable.update { it.copy(savedLogin = true) }
                    // A local decrypted cookie is not proof of server admission. Only a
                    // read-only catalog request runs automatically; never prompt/resume/grant.
                    val rpcId = id()
                    NativeCodec.catalog(unary("companion/listChats", rpcId, NativeRequests.catalog(rpcId, 100, null)))
                    if (epoch != generation) return@restoringStartup
                    if (!bindReadAuthority(readEpoch, replace = false) || epoch != generation) return@restoringStartup
                    mutable.update { it.copy(authenticated = true, busy = false, status = "Login restaurado") }
                    refresh()
                } catch (error: Exception) {
                    if (error is CancellationException) throw error
                    if (epoch != generation) return@restoringStartup
                    val auth = error is TransportFailure && error.kind == TransportFailure.Kind.AUTH_REQUIRED
                    mutable.update { it.copy(busy = false, authenticated = false, savedLogin = !auth,
                        status = "Login não verificado", error = if (auth) "O login expirou. Entre com o link privado atual."
                        else "Não foi possível verificar o login salvo. Tente novamente ou esqueça-o localmente.") }
                }
            }
        }
    }

    override fun logout() {
        if (state.value.busy || state.value.delivery == DeliveryStatus.SENDING) return
        val (readEpoch, previousReadScope) = revokeReadAuthority()
        val unregister = GoalNotifications.prepareUnregistration(getApplication())
        revokeNotificationAuthority()
        resetConnection()
        val epoch = generation
        mutable.update { it.copy(busy = true, connected = false, approvals = emptyList(), error = null) }
        viewModelScope.launch {
            try {
                try {
                    clearReadAuthority(readEpoch, previousReadScope)
                    unregisterNativePush(unregister)
                }
                finally { withContext(kotlinx.coroutines.NonCancellable + Dispatchers.IO) { transport.forgetLogin() } }
                if (epoch != generation) return@launch
                // Keep the RAM delivery ledger: logout is not proof an unknown send failed.
                mutable.update { CompanionUiState(status = "Login esquecido neste aparelho", showModelContext = it.showModelContext,
                    appStarted = uiLifecycle.started, appResumed = uiLifecycle.resumed) }
            } catch (error: Exception) {
                if (error is CancellationException) throw error
                if (epoch != generation) return@launch
                mutable.update { CompanionUiState(savedLogin = true,
                    error = "Não foi possível apagar o login salvo. Tente esquecer novamente.", showModelContext = it.showModelContext,
                    appStarted = uiLifecycle.started, appResumed = uiLifecycle.resumed) }
            }
        }
    }

    override fun login(link: String) {
        if (state.value.busy) return
        val readEpoch = revokeReadAuthority().first
        revokeNotificationAuthority()
        resetConnection()
        val epoch = generation
        mutable.update { CompanionUiState(busy = true, status = "Entrando", showModelContext = it.showModelContext,
            appStarted = uiLifecycle.started, appResumed = uiLifecycle.resumed) }
        viewModelScope.launch {
            try {
                withContext(Dispatchers.IO) { transport.login(link) }
                if (epoch != generation) return@launch
                if (!bindReadAuthority(readEpoch, replace = true) || epoch != generation) return@launch
                mutable.update { it.copy(authenticated = true, savedLogin = true, busy = false, status = "Autenticado") }
                refresh()
            } catch (error: Exception) { failure(error, epoch) }
        }
    }

    override fun refresh() {
        refreshCatalog()
    }

    private fun refreshCatalog(clockToken: CatalogState? = null): Boolean {
        if (!uiLifecycle.started || !state.value.authenticated || state.value.deletingId != null ||
            state.value.settings.selectionStatus == SettingsSelectionStatus.SAVING) return false
        val clockOwner = catalogInvalidation
        val listLease = if (clockToken != null) metadataLease else null
        val serial = ++catalogSerial
        val epoch = generation
        mutable.update { it.copy(busy = true, error = null,
            status = if (it.selectedId == null) "Atualizando conversas" else it.status) }
        val listJob = viewModelScope.launch {
            var completed = false
            try {
                val rows = linkedMapOf<String, CompanionChat>()
                // This list, not an earlier cached page set, fulfills the observed invalidation token.
                val cursors = mutableSetOf<String>()
                var cursor: String? = null
                do {
                    val rpcId = id()
                    val page = NativeCodec.catalog(unary("companion/listChats", rpcId, NativeRequests.catalog(rpcId, 100, cursor)))
                    if (epoch != generation || serial != catalogSerial) return@launch
                    if (clockToken != null && listLease?.let(::metadataCurrent) != true) return@launch
                    for (chat in page.chats) {
                        check(rows.put(chat.id, chat) == null) { "catalog-duplicate" }
                        check(rows.size <= 4096) { "catalog-limit" }
                    }
                    cursor = page.nextCursor
                    if (cursor != null) check(cursors.add(cursor) && cursors.size <= 128) { "catalog-no-progress" }
                } while (cursor != null)
                deleteUncertainIds.retainAll(rows.keys)
                interactions.reconcileCatalog(rows.values)
                mutable.update { it.copy(chats = mergeRefreshedCatalog(it.chats, rows.values.toList()), busy = false, deleteUncertainIds = deleteUncertainIds.toSet(),
                    status = if (it.selectedId == null) "Conversas" else it.status) }
                bindNotificationAuthority(rows.keys.toSet())
                startActivityReconciliation()
                maybeSubmitFirstDraft()
                publishInteractions()
                reconcileAnswererVisibility()
                completed = true
            } catch (error: Exception) {
                if (serial == catalogSerial) {
                    failure(error, epoch)
                    if (epoch == generation) maybeSubmitFirstDraft()
                }
                return@launch
            } finally {
                // Cancellation must not strand the pending clock; failure retries only on a later poll.
                if (clockToken != null) clockOwner.complete(clockToken, completed)
            }
            if (clockOwner === catalogInvalidation && epoch == generation) refreshCatalogFromClock()
        }
        if (clockToken != null) { metadataCatalogJob = listJob; metadataCatalogSerial = serial }
        return true
    }

    override fun refreshModelCatalog() {
        val snapshot = state.value
        if (!uiLifecycle.started || !snapshot.authenticated || snapshot.busy || snapshot.selectedId != null || snapshot.settings.loading) return
        val epoch = generation
        val serial = ++modelCatalogSerial
        mutable.update { it.copy(settings = it.settings.copy(loading = true, error = null)) }
        viewModelScope.launch {
            try {
                val inventory = SettingsCatalogAccumulator()
                var cursor: String? = null
                do {
                    val rpcId = id()
                    val page = ManagementCodec.modelCatalog(unary("companion/modelCatalog", rpcId, ManagementRequests.modelCatalog(rpcId, cursor)))
                    if (epoch != generation || serial != modelCatalogSerial) return@launch
                    inventory.add(page)
                    cursor = page.nextCursor
                } while (cursor != null)
                val metadata = inventory.metadata
                val intentConfirmed = confirmedPendingDefault(metadata.current, pendingDefaultModel, previousDefaultModel)
                if (intentConfirmed) {
                    pendingDefaultModel = null
                    previousDefaultModel = null
                }
                val uncertain = pendingDefaultModel != null
                mutable.update { it.copy(settings = it.settings.copy(
                    defaultModel = metadata.current.settingsChoice(), models = inventory.models.map { model ->
                        SettingsModelOption(model.provider, model.providerName, model.id, model.name, model.description,
                            model.efforts.map { SettingsReasoningEffort(it.id, it.name, it.description) }, model.defaultEffort)
                    }, loading = false, error = null, unavailableProviders = metadata.unavailableProviders,
                    catalogVersion = serial, canSelectDefault = metadata.writable,
                    selectionStatus = if (uncertain) SettingsSelectionStatus.UNKNOWN else SettingsSelectionStatus.IDLE,
                    selectionMessage = appModelCatalogSelectionMessage(uncertain, intentConfirmed, it.settings.selectionMessage),
                )) }
            } catch (error: Exception) {
                if (error is CancellationException) throw error
                if (epoch != generation || serial != modelCatalogSerial) return@launch
                mutable.update { it.copy(settings = it.settings.copy(loading = false, canSelectDefault = false,
                    error = "Não foi possível carregar os modelos. Atualize para tentar novamente.")) }
                if (error is TransportFailure && error.kind == TransportFailure.Kind.AUTH_REQUIRED) failure(error, epoch)
            }
        }
    }

    override fun setShowModelContext(visible: Boolean) {
        if (state.value.showModelContext == visible) return
        displayPreferences.showModelContext(visible)
        // Withdraw an already-visible debug frame before the worker computes its replacement.
        latestPresentation = null
        mutable.update { it.copy(showModelContext = visible, messages = emptyList(), richMessages = emptyList(),
            streamingText = null, transcriptRevision = -1, presentationPending = it.selectedId != null) }
        publish()
    }

    override fun chooseDefaultModel(choice: SettingsModelChoice) {
        val snapshot = state.value
        val expected = snapshot.settings.defaultModel ?: return
        if (!snapshot.authenticated || snapshot.busy || snapshot.selectedId != null || pendingDefaultModel != null ||
            !snapshot.settings.accepts(choice) || choice == expected) return
        val target = choice.protocolChoice()
        val previous = expected.protocolChoice()
        val epoch = generation
        modelCatalogSerial++
        pendingDefaultModel = target
        previousDefaultModel = previous
        mutable.update { it.copy(busy = true, error = null, settings = it.settings.copy(loading = false,
            selectionStatus = SettingsSelectionStatus.SAVING, selectionMessage = null)) }
        viewModelScope.launch {
            if (epoch != generation) return@launch
            try {
                val rpcId = id()
                val result = unaryResult("companion/selectAppModel", rpcId,
                    AppModelRequests.selectAppModel(rpcId, target, previous), allowRefusal = true)
                if (epoch != generation) return@launch
                if (result is RpcResult.Failure && result.code in MODEL_REFUSALS) {
                    pendingDefaultModel = null
                    previousDefaultModel = null
                    mutable.update { it.copy(busy = false, settings = it.settings.copy(canSelectDefault = false,
                        selectionStatus = SettingsSelectionStatus.IDLE,
                        selectionMessage = "Padrão não alterado. Atualize os modelos antes de escolher novamente.")) }
                    return@launch
                }
                val verified = AppModelCodec.selected(result.requireValue(), target)
                pendingDefaultModel = null
                previousDefaultModel = null
                mutable.update { it.copy(busy = false, settings = it.settings.copy(defaultModel = verified.current.settingsChoice(),
                    selectionStatus = SettingsSelectionStatus.IDLE, selectionMessage = appModelBanner(verified))) }
            } catch (error: Exception) {
                if (error is CancellationException) throw error
                if (epoch != generation) return@launch
                mutable.update { it.copy(busy = false, settings = it.settings.copy(selectionStatus = SettingsSelectionStatus.UNKNOWN,
                    selectionMessage = APP_MODEL_UNCONFIRMED_BANNER)) }
                if (error is TransportFailure && error.kind == TransportFailure.Kind.AUTH_REQUIRED) failure(error, epoch)
            }
        }
    }

    override fun deleteChat(chat: CompanionChat) {
        val snapshot = state.value
        if (!snapshot.authenticated || snapshot.busy || snapshot.selectedId != null || chat.createdAt == null ||
            snapshot.chats.none { it == chat } || chat.id in deleteUncertainIds ||
            submissions.status(chat.id) in setOf(DeliveryStatus.SENDING, DeliveryStatus.UNKNOWN)) return
        val epoch = generation
        catalogSerial++
        modelCatalogSerial++
        mutable.update { it.copy(busy = true, deletingId = chat.id, lastDeletedChatId = null, error = null,
            settings = it.settings.copy(loading = false)) }
        viewModelScope.launch {
            if (epoch != generation) return@launch
            // Keep the private latch across generation changes: stale replies cannot authorize a replay.
            deleteUncertainIds.add(chat.id)
            try {
                val rpcId = id()
                val result = unaryResult("companion/deleteChat", rpcId, ManagementRequests.deleteChat(rpcId, chat), allowRefusal = true)
                if (epoch != generation) return@launch
                if (result is RpcResult.Failure && result.code in DELETE_REFUSALS) {
                    deleteUncertainIds.remove(chat.id)
                    mutable.update { it.copy(busy = false, deletingId = null, deleteUncertainIds = deleteUncertainIds.toSet(),
                        error = if (result.code == "companion/delete-busy") "Conversa em uso. Encerre-a no DSH antes de excluir."
                        else "Conversa não excluída. Atualize a lista antes de tentar novamente.") }
                    return@launch
                }
                ManagementCodec.deleted(result.requireValue(), chat.id)
                deleteUncertainIds.remove(chat.id)
                drafts.remove(chat.id)
                interactions.withdraw(chat.id)
                publishInteractions()
                bindNotificationAuthority(ownedSessionIds - chat.id)
                mutable.update { it.copy(busy = false, deletingId = null, chats = it.chats.filterNot { row -> row.id == chat.id },
                    deleteUncertainIds = deleteUncertainIds.toSet(), lastDeletedChatId = chat.id,
                    status = "Conversa movida para a lixeira recuperável") }
            } catch (error: Exception) {
                if (error is CancellationException) throw error
                if (epoch != generation) return@launch
                mutable.update { it.copy(busy = false, deletingId = null, deleteUncertainIds = deleteUncertainIds.toSet(),
                    error = "Exclusão sem confirmação. Atualize a lista; não repita esta exclusão.") }
                if (error is TransportFailure && error.kind == TransportFailure.Kind.AUTH_REQUIRED) failure(error, epoch)
            }
        }
    }

    private fun ModelChoice.settingsChoice(): SettingsModelChoice = SettingsModelChoice(provider, model, reasoningEffort)
    private fun SettingsModelChoice.protocolChoice(): ModelChoice = ModelChoice(provider, model, reasoningEffort)

    private fun humanSubmissionCurrent(proof: AdmittedChat, epoch: Long, createdAt: Long): Boolean {
        val current = state.value
        val header = journal?.readyHeader() ?: return false
        return epoch == generation && admitted === proof && proof.admission.generation == epoch &&
            current.selectedId == proof.chat.id && !current.isNewDraft && current.authenticated && current.connected && answererVisible() &&
            header.id == proof.chat.id && header.createdAt == createdAt && header.agentPreset == "companion"
    }

    /** Human Send/continued-answer only. A read confirms intent, the addressed receipt confirms next-step application. */
    private suspend fun applyModelForHumanSubmission(proof: AdmittedChat, epoch: Long, isCurrent: () -> Boolean) {
        val createdAt = proof.chat.createdAt ?: throw AppModelPreflightFailure()
        val scope = readNamespace ?: throw AppModelPreflightFailure()
        val authEpoch = readScopeAuthEpoch
        val target = AppModelTarget(proof.chat.id, createdAt)
        requireCurrentAppModel(target,
            isCurrent = { authEpoch == readScopeAuthEpoch && readNamespace === scope && humanSubmissionCurrent(proof, epoch, createdAt) && isCurrent() },
            readCurrent = {
                val rpcId = id()
                ManagementCodec.modelCatalog(unary("companion/modelCatalog", rpcId, ManagementRequests.modelCatalog(rpcId))).current
            },
            apply = { current ->
                val rpcId = id()
                unary("companion/applyAppModel", rpcId, AppModelRequests.applyAppModel(rpcId, target.sessionId, target.createdAt, current))
            })
    }

    override fun create() {
        val current = state.value
        if (!current.authenticated || current.busy || current.delivery in setOf(DeliveryStatus.UNKNOWN, DeliveryStatus.SENDING)) return
        current.selectedId?.let { drafts[it] = current.draft }
        if (current.isNewDraft) newChatDraft.edit(current.draft)
        if (!current.isNewDraft) clearFileDraft()
        resetConnection()
        val local = newChatDraft.snapshot()
        val known = local.sessionId
        if (known != null) {
            // A real-session draft may have been edited after the original admission failed.
            drafts.putIfAbsent(known, local.text)
            check(newChatDraft.transferredKnownSession(known))
            mutable.update { it.copy(busy = false) }
            select(known)
            return
        }
        mutable.update { it.copy(selectedId = null, isNewDraft = true, title = "Nova conversa",
            messages = emptyList(), richMessages = emptyList(), streamingText = null, hasMore = false,
            approvals = emptyList(), connected = false, busy = false, presentationPending = false,
            draft = local.text, error = null, status = "Rascunho local", resendFiles = 0,
            delivery = if (local.phase == NewChatDraftController.Phase.CREATE_UNKNOWN) DeliveryStatus.UNKNOWN else DeliveryStatus.NONE) }
        reconcileAnswererVisibility()
    }

    override fun select(id: String) = selectInternal(id)

    private fun selectInternal(id: String, fromDraft: NewChatDraftController.Ticket? = null) {
        if (!uiLifecycle.started || !state.value.authenticated || state.value.busy) return
        val previousEpoch = generation
        if (fromDraft != null && !newChatDraft.current(fromDraft, previousEpoch, id)) return
        if (state.value.isNewDraft) newChatDraft.edit(state.value.draft)
        state.value.selectedId?.let { drafts[it] = state.value.draft }
        val previous = state.value
        val capturedFiles = if (fromDraft != null) firstDraft?.files else null
        if (fromDraft == null && previous.selectedId != id) historyWindow.reset()
        if (fromDraft == null && (previous.selectedId != id || previous.isNewDraft)) clearFileDraft(id)
        resetConnection(preserveDraft = fromDraft)
        val epoch = generation
        if (fromDraft != null) {
            if (!newChatDraft.adopt(fromDraft, previousEpoch, epoch, id)) return
            firstDraft = FirstDraft(fromDraft, epoch, id, capturedFiles)
            fileRouteId = id
            capturedFiles?.let { it.epoch = epoch; it.sessionId = id }
        } else {
            val local = newChatDraft.snapshot()
            if (local.sessionId == id && !local.pending) {
                drafts.putIfAbsent(id, local.text)
                check(newChatDraft.transferredKnownSession(id))
            }
        }
        mutable.update { it.copy(
            selectedId = id, isNewDraft = false, title = it.chats.find { chat -> chat.id == id }?.title ?: chatTitleFallback(id),
            messages = if (previous.selectedId == id) previous.messages else emptyList(),
            richMessages = if (previous.selectedId == id) previous.richMessages else emptyList(),
            streamingText = null, connected = false, busy = true, status = "Verificando conversa",
            error = null, approvals = emptyList(), draft = if (fromDraft != null) "" else drafts[id].orEmpty(),
            delivery = if (fromDraft != null) DeliveryStatus.SENDING else submissions.status(id),
        ) }
        updateDelivery()
        selectedOpenJob = viewModelScope.launch {
            val owner = currentCoroutineContext().job
            try {
                val rpcId = CompanionViewModel.id()
                val proof = NativeCodec.detail(unary("companion/detail", rpcId, NativeRequests.detail(rpcId, id)), id, epoch)
                if (epoch != generation || !answererVisible()) return@launch
                if (fileRouteId == id) {
                    if (fileRouteCreatedAt != null && fileRouteCreatedAt != proof.chat.createdAt) clearFileDraft(id, proof.chat.createdAt)
                    else fileRouteCreatedAt = proof.chat.createdAt
                }
                if (capturedFiles?.active == true && activeFileSend === capturedFiles) capturedFiles.createdAt = proof.chat.createdAt
                admitted = proof
                bindNotificationAuthority(ownedSessionIds + proof.chat.id)
                startActivityReconciliation()
                responses.begin(proof.chat.id, epoch)
                journal = SessionJournal(proof.admission)
                assistant = AssistantAssembler(epoch)
                assistantLiveDegraded = false
                interactions.admit(proof, epoch, interactions.sourceToken)
                mutable.update { publishVerifiedChat(it, proof).copy(busy = false, status = "Conectando") }
                openSocket(epoch, proof)
            } catch (error: Exception) {
                if (error is CancellationException) throw error
                if (fromDraft != null) {
                    retireFileSend()
                    newChatDraft.failed(fromDraft, epoch)
                    if (firstDraft?.ticket === fromDraft) firstDraft = null
                }
                failure(error, epoch)
                if (epoch == generation) updateDelivery()
                // Offline while the conversation is on screen: keep trying to reopen it (read-only).
                if (fromDraft == null && epoch == generation && error is TransportFailure && error.kind == TransportFailure.Kind.NETWORK) {
                    scheduleAnswererReconnect(retryable = true)
                }
            } finally { if (selectedOpenJob === owner) selectedOpenJob = null }
        }
    }

    override fun back() {
        clearFileDraft()
        if (state.value.isNewDraft) newChatDraft.edit(state.value.draft)
        state.value.selectedId?.let { drafts[it] = state.value.draft }
        resetConnection()
        mutable.update { it.copy(selectedId = null, isNewDraft = false, hasMore = false, presentationPending = false,
            messages = emptyList(), richMessages = emptyList(), streamingText = null,
            approvals = emptyList(), draft = "", connected = false, busy = false, title = "Conversas",
            status = "Conversas", delivery = DeliveryStatus.NONE, resendFiles = 0) }
        reconcileAnswererVisibility()
    }
    private fun currentFileDraft(): UploadDraftIdentity? {
        val scope = readNamespace ?: return null
        if (!state.value.authenticated) return null
        return UploadDraftIdentity(readScopeAuthEpoch, "${OwnerOrigin.ORIGIN}|${scope.nonce}", scope.profile, fileDraftId)
    }

    private fun publishSelectedFiles() {
        mutable.update { it.copy(selectedFiles = selectedFiles.map { file -> SelectedFileChip(file.selectionId, file.name, file.declaredBytes, filesNeedReselect) }) }
    }

    private fun retireFileSend() {
        val pending = activeFileSend ?: return
        val localCreate = firstDraft?.files === pending && state.value.isNewDraft
        pending.active = false
        activeFileSend = null
        transport.cancelFileUploads()
        fileSendJob?.cancel(); fileSendJob = null
        if (pending.promptAttempted) submissions.interrupted(pending.epoch)
        if (pending.uploadStarted) filesNeedReselect = selectedFiles.isNotEmpty()
        if (firstDraft?.files === pending) { newChatDraft.interrupt(pending.epoch); firstDraft = null }
        pending.sessionId?.let { preparations.release(it, pending.requestId, pending.epoch) }
        mutable.update { it.copy(fileSendPhase = FileSendPhase.NONE, busy = if (localCreate) false else it.busy) }
        publishSelectedFiles()
    }

    private fun clearFileDraft(sessionId: String? = null, createdAt: Long? = null) {
        retireFileSend()
        pickerTicket = null
        fileMetadataJob?.cancel(); fileMetadataJob = null
        fileDraftId = id(); fileRouteId = sessionId; fileRouteCreatedAt = createdAt
        selectedFiles = emptyList(); filesNeedReselect = false
        mutable.update { it.copy(selectedFiles = emptyList(), filePickerPending = false, fileSendPhase = FileSendPhase.NONE) }
    }

    /** The platform adapter invokes this only for the explicit 48dp attach action. */
    fun beginFilePicker(): Boolean {
        val current = state.value
        // An UNKNOWN file prompt may reselect its files, but only to resend that same intent.
        if (!uiLifecycle.started || !current.authenticated || !current.hasOpenConversation || current.busy || activeFileSend != null ||
            current.filePickerPending || current.delivery == DeliveryStatus.SENDING ||
            current.delivery == DeliveryStatus.UNKNOWN && current.resendFiles == 0) return false
        val draft = currentFileDraft() ?: return false
        if (!current.isNewDraft && (current.selectedId != fileRouteId || fileRouteCreatedAt == null)) {
            mutable.update { it.copy(error = "Aguarde a verificação da conversa antes de selecionar arquivos.") }; return false
        }
        pickerTicket = FilePickerTicket(draft, fileRouteId, fileRouteCreatedAt)
        mutable.update { it.copy(filePickerPending = true, error = null) }
        return true
    }

    fun filePickerUnavailable() {
        pickerTicket = null
        mutable.update { it.copy(filePickerPending = false, error = "O seletor de documentos está indisponível.") }
    }

    /** A late or restored platform result without the exact in-memory ticket grants nothing. */
    fun acceptPickedFiles(uris: List<Uri>) {
        val ticket = pickerTicket ?: return
        pickerTicket = null
        val current = currentFileDraft()
        if (current == null || !ticket.matches(current, fileRouteId, fileRouteCreatedAt)) { mutable.update { it.copy(filePickerPending = false) }; return }
        if (uris.isEmpty()) { mutable.update { it.copy(filePickerPending = false) }; return }
        if (uris.size > FileUploadLimits.MAX_FILES || uris.distinct().size != uris.size) {
            mutable.update { it.copy(filePickerPending = false, error = "Escolha até 4 arquivos diferentes, com total de até 20 MiB.") }; return
        }
        val snapshot = uris.toList()
        fileMetadataJob = viewModelScope.launch {
            val owner = currentCoroutineContext().job
            try {
                val selected = snapshot.map { readPickedUploadFile(getApplication<Application>().contentResolver, it, ticket.draft) }
                val now = currentFileDraft()
                if (now == null || !ticket.matches(now, fileRouteId, fileRouteCreatedAt)) return@launch
                validateSelectedUploads(selected, now)
                selectedFiles = selected.toList(); filesNeedReselect = false
                publishSelectedFiles()
            } catch (error: Exception) {
                if (error is CancellationException) throw error
                val now = currentFileDraft()
                if (now != null && ticket.matches(now, fileRouteId, fileRouteCreatedAt)) mutable.update { it.copy(error =
                    if (error is IllegalArgumentException || error is FileTransferFailure && error.kind == FileTransferFailure.Kind.TOO_LARGE)
                        "Escolha até 4 arquivos com total de até 20 MiB."
                    else "Não foi possível conferir os documentos. Selecione-os novamente.") }
            } finally {
                if (fileMetadataJob === owner) { fileMetadataJob = null; mutable.update { it.copy(filePickerPending = false) } }
            }
        }
    }

    override fun removeFile(selectionId: String) {
        if (selectedFiles.none { it.selectionId == selectionId }) return
        retireFileSend()
        selectedFiles = selectedFiles.filterNot { it.selectionId == selectionId }
        if (selectedFiles.isEmpty()) filesNeedReselect = false
        publishSelectedFiles(); updateDelivery()
    }

    private fun captureFileSend(literal: String, requestId: String = id()): FileSendIntent? {
        val draft = currentFileDraft() ?: return null
        if (selectedFiles.isEmpty() || filesNeedReselect || activeFileSend != null || state.value.filePickerPending) return null
        try { validateSelectedUploads(selectedFiles, draft) } catch (_: IllegalArgumentException) {
            mutable.update { it.copy(error = "Seleção indisponível. Selecione até 4 arquivos com total de até 20 MiB.") }; return null
        }
        return FileSendIntent(draft, selectedFiles.toList(), literal, requestId, generation, fileRouteId, fileRouteCreatedAt).also { activeFileSend = it }
    }

    private fun fileSendCurrent(intent: FileSendIntent, sessionId: String, createdAt: Long, epoch: Long): Boolean {
        val draft = currentFileDraft() ?: return false
        val header = journal?.readyHeader() ?: return false
        if (header.id != sessionId || header.createdAt != createdAt || header.agentPreset != "companion") return false
        val current = state.value
        return intent.active && activeFileSend === intent && intent.draft.matches(draft) && epoch == generation &&
            intent.epoch == epoch && intent.sessionId == sessionId && intent.createdAt == createdAt && fileRouteId == sessionId &&
            fileRouteCreatedAt == createdAt && current.selectedId == sessionId && current.authenticated && current.connected && current.appStarted &&
            admitted?.chat?.id == sessionId && admitted?.chat?.createdAt == createdAt
    }

    override fun draft(text: String) {
        if (state.value.isNewDraft) newChatDraft.edit(text)
        mutable.update { it.copy(draft = text) }
    }
    override fun reconnect() {
        val selected = state.value.selectedId
        if (state.value.busy) return
        answererRetry.reset()
        if (selected == null) {
            refresh()
            // The events carrier does not depend on the catalog read succeeding.
            reconcileAnswererVisibility()
        } else select(selected)
    }

    override fun send() {
        val current = state.value
        if (current.filePickerPending || activeFileSend != null || filesNeedReselect) return
        if (current.isNewDraft) { sendFirstDraft(); return }
        val proof = admitted ?: return
        if (!current.connected || current.selectedId != proof.chat.id || (current.draft.isBlank() && selectedFiles.isEmpty()) ||
            current.delivery == DeliveryStatus.UNKNOWN || current.delivery == DeliveryStatus.SENDING) return
        val files = if (selectedFiles.isNotEmpty()) captureFileSend(current.draft) ?: return else null
        if (!submitAdmitted(proof, current.draft, files?.requestId ?: id(), generation, files = files) && files != null) retireFileSend()
    }

    /**
     * Explicit owner action for an UNKNOWN delivery; nothing calls this automatically. A chat prompt
     * is resent with its original requestId and literal (the host admits a requestId once), files
     * via a fresh reselection. An uncertain "Nova conversa" is released and created again: at
     * worst an extra empty chat remains, which is harmless, unlike a silent repeat.
     */
    override fun resendUncertain() {
        val current = state.value
        if (!current.authenticated || current.busy || current.delivery != DeliveryStatus.UNKNOWN ||
            current.filePickerPending || activeFileSend != null) return
        if (current.isNewDraft) {
            if (current.selectedId != null) return
            newChatDraft.edit(current.draft)
            if (!newChatDraft.releaseUncertainCreate()) return
            updateDelivery()
            sendFirstDraft()
            return
        }
        val proof = admitted ?: return
        if (!current.connected || current.selectedId != proof.chat.id) return
        val entry = submissions.entry(proof.chat.id)?.takeIf { it.status == DeliveryStatus.UNKNOWN } ?: return
        val files = if (entry.files.isEmpty()) null else {
            if (filesNeedReselect || selectedFiles.size != entry.files.size) {
                mutable.update { it.copy(error = "Selecione novamente os mesmos arquivos antes de reenviar.") }
                return
            }
            captureFileSend(entry.text, entry.requestId) ?: return
        }
        if (!submitAdmitted(proof, entry.text, entry.requestId, generation, files = files, resend = true) && files != null) retireFileSend()
    }

    private fun sendFirstDraft() {
        val current = state.value
        if (!current.authenticated || !current.isNewDraft || current.selectedId != null || current.busy ||
            current.filePickerPending || filesNeedReselect || activeFileSend != null || current.delivery in setOf(DeliveryStatus.SENDING, DeliveryStatus.UNKNOWN)) return
        newChatDraft.edit(current.draft)
        val epoch = generation
        val files = if (selectedFiles.isNotEmpty()) captureFileSend(current.draft) ?: return else null
        val ticket = newChatDraft.begin(epoch, hasFiles = files != null) ?: run { if (files != null) retireFileSend(); return }
        firstDraft = FirstDraft(ticket, epoch, files = files)
        mutable.update { it.copy(busy = true, delivery = DeliveryStatus.SENDING, error = null, status = "Preparando primeira mensagem",
            draft = "", pendingPrompt = ticket.literal,
            fileSendPhase = if (files != null) FileSendPhase.PREPARING else FileSendPhase.NONE) }
        val createJob = viewModelScope.launch {
            try {
                if (epoch != generation || !state.value.authenticated || !state.value.isNewDraft ||
                    !newChatDraft.markCreateAttempted(ticket, epoch)) return@launch
                val rpcId = id()
                val receipt = NativeCodec.created(unary("session/create", rpcId, NativeRequests.create(rpcId)))
                if (!newChatDraft.created(ticket, epoch, receipt.sessionId)) return@launch
                if (epoch != generation || !state.value.authenticated || !state.value.isNewDraft) {
                    newChatDraft.interrupt(epoch)
                    return@launch
                }
                // Submitted draft: clear draft so selecting does not restore text into composer.
                drafts[receipt.sessionId] = ""
                mutable.update { it.copy(busy = false) }
                selectInternal(receipt.sessionId, ticket)
            } catch (error: Exception) {
                newChatDraft.failed(ticket, epoch)
                if (firstDraft?.ticket === ticket) firstDraft = null
                if (files != null && activeFileSend === files) retireFileSend()
                failure(error, epoch, "Criação ou abertura sem confirmação. Texto preservado; esta tentativa não será repetida automaticamente.")
                if (epoch == generation) updateDelivery()
            }
        }
        if (files != null) fileSendJob = createJob
    }

    private fun maybeSubmitFirstDraft() {
        val pending = firstDraft ?: return
        val sid = pending.sessionId ?: return
        val proof = admitted ?: return
        val current = state.value
        if (pending.generation != generation || proof.chat.id != sid || proof.admission.generation != generation ||
            current.selectedId != sid || current.isNewDraft || !current.authenticated || !current.connected || current.busy ||
            !newChatDraft.current(pending.ticket, generation, sid)) return
        if (pending.files != null && (!pending.files.active || activeFileSend !== pending.files)) return
        submitAdmitted(proof, pending.ticket.literal, pending.files?.requestId ?: id(), generation, pending.ticket, pending.files)
    }

    private fun submitAdmitted(proof: AdmittedChat, literal: String, requestId: String, epoch: Long,
        fromDraft: NewChatDraftController.Ticket? = null, files: FileSendIntent? = null, resend: Boolean = false): Boolean {
        if (epoch != generation || admitted !== proof || proof.admission.generation != epoch ||
            state.value.selectedId != proof.chat.id || !state.value.authenticated || !state.value.connected) return false
        // Stream publications during header preflight must not enable a second tap.
        if (!preparations.acquire(proof.chat.id, requestId, epoch)) return false
        if (fromDraft != null) {
            if (!newChatDraft.takeForSubmit(fromDraft, epoch, proof.chat.id)) {
                preparations.release(proof.chat.id, requestId, epoch)
                return false
            }
            check(newChatDraft.transferred(fromDraft, proof.chat.id))
            if (firstDraft?.ticket === fromDraft) firstDraft = null
        }
        val createdReadScope = if (fromDraft != null) readNamespace else null
        val createdReadState = if (fromDraft != null) conversationReads else null
        val createdReadAuthority = readScopeAuthEpoch
        mutable.update { it.copy(delivery = DeliveryStatus.SENDING, error = null,
            draft = "", pendingPrompt = literal,
            fileSendPhase = if (files != null) FileSendPhase.PREPARING else FileSendPhase.NONE) }
        val sendJob = viewModelScope.launch {
            var postAttempted = false
            var modelPrepared = false
            try {
                // Recheck immutable header immediately before the mutation; never trust a stale list hint.
                val gateId = id()
                val gate = NativeCodec.detail(unary("companion/detail", gateId, NativeRequests.detail(gateId, proof.chat.id)), proof.chat.id, epoch)
                if (epoch != generation || !preparations.current(proof.chat.id, requestId, epoch)) return@launch
                val createdAt = proof.chat.createdAt
                val history = journal?.state()
                val header = history?.header
                if (fromDraft != null && createdReadScope != null && createdReadState != null &&
                    createdReadAuthority == readScopeAuthEpoch && readNamespace == createdReadScope && conversationReads === createdReadState &&
                    uiLifecycle.started && state.value.authenticated && state.value.connected && admitted === proof &&
                    state.value.selectedId == proof.chat.id && gate.admission.generation == epoch &&
                    createdAt != null && createdAt >= 0 && gate.chat.createdAt == createdAt &&
                    history?.ready == true && header != null && header.id == proof.chat.id && header.createdAt == createdAt) {
                    // Only the consumed native-create ticket establishes that this is not historical
                    // bootstrap. Seed no read/absence proof, so its first later reply can be unread.
                    if (createdReadState.seedCreated(createdReadScope, proof.chat.id, createdAt)) persistReadState()
                }
                if (createdAt == null || header == null || gate.chat.createdAt != createdAt || header.createdAt != createdAt ||
                    header.id != proof.chat.id || !history.ready) throw AppModelPreflightFailure()
                // Complete outside native prompt/image admission; never replay a changing model call.
                applyModelForHumanSubmission(proof, epoch) {
                    preparations.current(proof.chat.id, requestId, epoch) && (files == null || fileSendCurrent(files, proof.chat.id, createdAt, epoch))
                }
                modelPrepared = true
                val uploaded = if (files != null) {
                    if (!fileSendCurrent(files, proof.chat.id, createdAt, epoch)) throw FileTransferFailure(FileTransferFailure.Kind.STALE)
                    val binding = UploadBinding(files.draft, gate.admission, createdAt)
                    files.uploadStarted = true
                    mutable.update { it.copy(fileSendPhase = FileSendPhase.UPLOADING) }
                    transport.uploadSelectedFiles(getApplication<Application>().contentResolver, files.files, binding) {
                        fileSendCurrent(files, proof.chat.id, createdAt, epoch)
                    }.also { if (!fileSendCurrent(files, proof.chat.id, createdAt, epoch)) throw FileTransferFailure(FileTransferFailure.Kind.STALE) }
                } else null
                val evidence = uploaded?.receipts?.map(SubmittedFileEvidence::from).orEmpty()
                val rpcId = id()
                val body = if (uploaded != null) NativeFileRequests.prompt(rpcId, proof.admission, requestId, literal, uploaded.receipts, uploaded.binding)
                    else NativeRequests.prompt(rpcId, proof.admission, requestId, literal)
                // A resend in the same carrier is already tracked under this requestId; that is not a refusal.
                if (!responses.prepare(requestId, literal, journal?.state()?.cursor ?: -1, epoch, evidence) && !resend) {
                    mutable.update { it.copy(error = "Não enviado: reconecte a conversa para renovar o acompanhamento.") }
                    return@launch
                }
                val ledgerEntry = if (resend) submissions.retry(proof.chat.id, requestId, epoch, evidence)
                    else submissions.begin(proof.chat.id, requestId, literal, epoch, evidence)
                if (ledgerEntry == null) { updateDelivery(); return@launch }
                if (files != null) {
                    if (!fileSendCurrent(files, proof.chat.id, uploaded!!.binding.sessionCreatedAt, epoch)) {
                        submissions.refusedBeforePost(proof.chat.id, requestId); return@launch
                    }
                    fileRequestSelections[requestId] = files.files.map { it.selectionId }
                    files.promptAttempted = true
                    mutable.update { it.copy(fileSendPhase = FileSendPhase.AWAITING_PROMPT) }
                }
                postAttempted = true
                val result = unary("session/prompt", rpcId, body)
                AdmissionReceipt.requireAccepted(result)
                responses.admitted(requestId, epoch)
                submissions.acknowledged(proof.chat.id, requestId, epoch, generation)
                if (epoch == generation) publish()
            } catch (error: Exception) {
                if (postAttempted) submissions.interrupted(epoch)
                failure(error, epoch, if (postAttempted) "Envio sem confirmação. Use Reenviar: o mesmo identificador não duplica a mensagem."
                    else if (!modelPrepared) "Não enviado: verificação da conversa ou escolha global sem confirmação. Atualize o estado antes de tentar novamente."
                    else if (files?.uploadStarted == true) "Arquivos sem confirmação de envio da mensagem. Remova-os ou selecione-os novamente; não haverá repetição automática."
                    else "Não enviado: a verificação da conversa falhou.")
                if (epoch == generation) updateDelivery()
            } finally {
                if (files != null && activeFileSend === files) {
                    files.active = false; activeFileSend = null; fileSendJob = null
                    val entry = submissions.entry(proof.chat.id)
                    if (files.uploadStarted && !(entry?.requestId == requestId && entry.status == DeliveryStatus.ADMITTED)) filesNeedReselect = selectedFiles.isNotEmpty()
                    mutable.update { it.copy(fileSendPhase = FileSendPhase.NONE) }
                    publishSelectedFiles()
                }
                preparations.release(proof.chat.id, requestId, epoch)
                if (epoch == generation) updateDelivery()
            }
        }
        if (files != null) fileSendJob = sendJob
        return true
    }

    override fun cancelTurn() {
        val stoppingFiles = activeFileSend != null
        retireFileSend()
        if (stoppingFiles) { updateDelivery(); mutable.update { it.copy(status = "Envio de arquivos interrompido; nenhuma repetição automática") } }
        val proof = admitted ?: return
        if ((!state.value.canStopResponse && !stoppingFiles) || state.value.selectedId != proof.chat.id ||
            proof.admission.generation != generation || opening) return
        val epoch = generation
        if (!responses.acquireStop(epoch)) return
        publish()
        viewModelScope.launch {
            try {
                if (epoch != generation || admitted !== proof || !state.value.connected) return@launch
                val rpcId = id()
                AdmissionReceipt.requireAccepted(unary("session/cancel", rpcId, NativeRequests.cancelTurn(rpcId, proof.admission)))
                responses.stopResult(true, epoch)
                if (epoch == generation) publish()
                if (epoch == generation) mutable.update { it.copy(status = "Cancelamento solicitado; fila preservada") }
            } catch (error: Exception) {
                responses.stopResult(false, epoch)
                if (epoch == generation) publish()
                failure(error, epoch, "Cancelamento sem confirmação; não será repetido.")
            }
        }
    }

    override fun refreshNativeGoals() {
        val proof = admitted ?: return
        if (hostObservation.suspended || !uiLifecycle.started || !uiLifecycle.resumed || !uiLifecycle.conversationVisible || state.value.selectedId != proof.chat.id ||
            state.value.isNewDraft || !state.value.authenticated || !state.value.connected || state.value.nativeGoals.pending) return
        val epoch = generation
        val serial = ++nativeReadSerial
        // Coalesce native events and human refreshes; read-only calls may be replaced, controls never replay.
        val hostEpoch = hostObservation.epoch
        nativeReadJob?.cancel()
        nativeReadJob = viewModelScope.launch {
            delay(180)
            try {
                val readSentAt = goalPermits.now()
                val rpcId = id()
                val result = unaryResult("nativeGoals/read", rpcId, NativeGoalRequests.read(rpcId, proof.admission), allowRefusal = true)
                if (epoch != generation || admitted !== proof || serial != nativeReadSerial || hostEpoch != hostObservation.epoch || hostObservation.suspended) return@launch
                if (result is RpcResult.Failure) {
                    mutable.update { it.copy(nativeGoals = it.nativeGoals.copy(control = null,
                        error = "Controle humano indisponível neste backend. Dados nativos exibidos sem retomada automática.")) }
                    return@launch
                }
                val observed = NativeGoalsCodec.read(result.requireValue(), proof.chat.id, epoch)
                val accepted = journal?.state() ?: return@launch
                if (!accepted.ready) return@launch
                val current = NativeGoalsCodec.catchUpRead(observed, accepted.records, accepted.cursor)
                if (current == null) {
                    mutable.update { it.copy(nativeGoals = it.nativeGoals.copy(control = null,
                        error = "O estado do goal mudou durante a consulta. Atualize para confirmar.")) }
                    return@launch
                }
                current.control?.let { goalPermits.issued(it.permit, readSentAt) }
                mutable.update { it.copy(nativeGoals = current) }
            } catch (error: Exception) {
                if (error is CancellationException) throw error
                if (epoch != generation || serial != nativeReadSerial) return@launch
                mutable.update { it.copy(nativeGoals = it.nativeGoals.copy(control = null, error = "Não foi possível atualizar o goal nativo.")) }
                if (error is TransportFailure && error.kind == TransportFailure.Kind.AUTH_REQUIRED) failure(error, epoch)
            }
        }
    }

    override fun controlNativeGoal(expected: NativeGoalControl, action: NativeGoalAction) {
        controlNativeGoal(expected, action, renewed = false)
    }

    private fun controlNativeGoal(expected: NativeGoalControl, action: NativeGoalAction, renewed: Boolean) {
        val proof = admitted ?: return
        val snapshot = state.value
        // The host permit lives 30 s; a stale one would be refused and turn this tap "uncertain".
        // Renew at most once per tap, so a slow link cannot loop reads.
        if (!renewed && expected == snapshot.nativeGoals.control && !goalPermits.fresh(expected.permit)) {
            renewNativeGoalPermit(proof, expected, action)
            return
        }
        if (hostObservation.suspended || opening || !nativeGoalOnce.acquire(expected, snapshot.nativeGoals, proof.chat.id, generation,
                snapshot.authenticated, snapshot.connected, action)) return
        val epoch = generation
        val serial = ++nativeReadSerial
        nativeReadJob?.cancel()
        mutable.update { it.copy(nativeGoals = it.nativeGoals.copy(pending = true, control = null, error = null)) }
        viewModelScope.launch {
            try {
                if (epoch != generation || admitted !== proof || !state.value.connected) return@launch
                val controlSentAt = goalPermits.now()
                val rpcId = id()
                if (serial != nativeReadSerial || hostObservation.suspended) {
                    mutable.update { it.copy(nativeGoals = it.nativeGoals.copy(pending = false, uncertain = true, control = null)) }
                    return@launch
                }
                val result = unaryResult("nativeGoals/control", rpcId, NativeGoalRequests.control(rpcId, expected, action), allowRefusal = true)
                if (epoch != generation || admitted !== proof) return@launch
                if (result is RpcResult.Failure) {
                    mutable.update { it.copy(nativeGoals = it.nativeGoals.copy(pending = false, uncertain = true, control = null,
                        error = "Controle não confirmado. Atualize o goal; esta ação não será repetida.")) }
                } else if (serial == nativeReadSerial && !hostObservation.suspended) {
                    val observed = NativeGoalsCodec.read(result.requireValue(), proof.chat.id, epoch)
                    val accepted = journal?.state()
                    val current = accepted?.takeIf { it.ready }?.let {
                        NativeGoalsCodec.catchUpRead(observed, it.records, it.cursor)
                    }
                    current?.control?.let { goalPermits.issued(it.permit, controlSentAt) }
                    mutable.update { it.copy(nativeGoals = current ?: it.nativeGoals.copy(pending = false,
                        uncertain = true, control = null, error = "Atualize para confirmar o estado após o controle.")) }
                } else {
                    // A newer native event wins over the HTTP observation at its older cut.
                    mutable.update { it.copy(nativeGoals = it.nativeGoals.copy(pending = false, uncertain = true, control = null)) }
                    refreshNativeGoals()
                }
            } catch (error: Exception) {
                if (error is CancellationException) throw error
                if (epoch != generation) return@launch
                mutable.update { it.copy(nativeGoals = it.nativeGoals.copy(pending = false, uncertain = true, control = null,
                    error = "Controle sem confirmação. Não reenviado; atualize para reconciliar.")) }
                if (error is TransportFailure && error.kind == TransportFailure.Kind.AUTH_REQUIRED) failure(error, epoch)
            }
        }
    }

    /** Read a fresh permit, then act once, only if the same goal revision still allows this action. */
    private fun renewNativeGoalPermit(proof: AdmittedChat, expected: NativeGoalControl, action: NativeGoalAction) {
        val snapshot = state.value
        if (hostObservation.suspended || opening || snapshot.nativeGoals.pending || !snapshot.authenticated || !snapshot.connected ||
            snapshot.selectedId != proof.chat.id) return
        val epoch = generation
        val serial = ++nativeReadSerial
        val hostEpoch = hostObservation.epoch
        nativeReadJob?.cancel()
        nativeReadJob = viewModelScope.launch {
            val owner = currentCoroutineContext().job
            try {
                val readSentAt = goalPermits.now()
                val rpcId = id()
                val result = unaryResult("nativeGoals/read", rpcId, NativeGoalRequests.read(rpcId, proof.admission), allowRefusal = true)
                if (epoch != generation || admitted !== proof || serial != nativeReadSerial || hostEpoch != hostObservation.epoch || hostObservation.suspended) return@launch
                val accepted = journal?.state()
                val current = if (result is RpcResult.Failure || accepted == null || !accepted.ready) null
                    else NativeGoalsCodec.catchUpRead(NativeGoalsCodec.read(result.requireValue(), proof.chat.id, epoch), accepted.records, accepted.cursor)
                if (current == null) {
                    mutable.update { it.copy(nativeGoals = it.nativeGoals.copy(control = null,
                        error = "Não foi possível renovar o controle do goal. Atualize e tente novamente.")) }
                    return@launch
                }
                val fresh = current.control
                fresh?.let { goalPermits.issued(it.permit, readSentAt) }
                mutable.update { it.copy(nativeGoals = current) }
                if (nativeReadJob === owner) nativeReadJob = null
                if (fresh != null && fresh.goalId == expected.goalId && fresh.revision == expected.revision) {
                    controlNativeGoal(fresh, action, renewed = true)
                } else {
                    mutable.update { it.copy(nativeGoals = it.nativeGoals.copy(error = "O goal mudou. Confira o estado antes de controlar.")) }
                }
            } catch (error: Exception) {
                if (error is CancellationException) throw error
                if (epoch != generation || serial != nativeReadSerial) return@launch
                mutable.update { it.copy(nativeGoals = it.nativeGoals.copy(control = null, error = "Não foi possível renovar o controle do goal.")) }
                if (error is TransportFailure && error.kind == TransportFailure.Kind.AUTH_REQUIRED) failure(error, epoch)
            } finally { if (nativeReadJob === owner) nativeReadJob = null }
        }
    }

    private fun metadataCurrent(lease: MetadataLease): Boolean = lease.accepts(uiLifecycle.started, uiLifecycle.resumed,
        state.value.authenticated, readScopeAuthEpoch, readNamespace, uiLifecycle.foregroundEpoch, metadataSerial)

    private fun stopForegroundMetadata() {
        metadataSerial++
        metadataJob?.cancel(); metadataJob = null; metadataLease = null
        if (metadataCatalogJob?.isActive == true) {
            metadataCatalogJob?.cancel()
            if (metadataCatalogSerial == catalogSerial) {
                catalogSerial++
                mutable.update { it.copy(busy = false) }
            }
        }
        metadataCatalogJob = null; metadataCatalogSerial = -1L
        catalogInvalidation = CatalogInvalidationClock()
        hostObservation.observe(null)
        nativeReadSerial++
        nativeReadJob?.cancel(); nativeReadJob = null
        interactionHeads = emptyMap(); interactionHeadsViewportEpoch = -1L
        mutable.update { it.copy(hostStatusMessage = null, interactionCheckHints = emptySet(),
            nativeGoals = it.nativeGoals.copy(control = null)) }
    }

    private fun startForegroundMetadata() {
        val scope = readNamespace ?: return
        if (!uiLifecycle.started || !uiLifecycle.resumed || !state.value.authenticated) return
        if (metadataJob?.isActive == true && metadataLease?.let(::metadataCurrent) == true) return
        stopForegroundMetadata()
        val lease = MetadataLease(readScopeAuthEpoch, scope, uiLifecycle.foregroundEpoch, metadataSerial)
        metadataLease = lease
        mutable.update { it.copy(hostStatusMessage = hostStatusLabel(null, null)) }
        metadataJob = viewModelScope.launch {
            while (metadataCurrent(lease)) {
                refreshHostStatus(lease)
                if (metadataCurrent(lease) && catalogObservationActive()) {
                    refreshCatalogClock(lease)
                    refreshInteractionHeads(lease)
                }
                delay(10000)
            }
        }
    }

    override fun refreshMetadata() {
        stopForegroundMetadata()
        startForegroundMetadata()
    }

    private suspend fun refreshHostStatus(lease: MetadataLease) {
        var status: HostStatus? = null
        try {
            val rpcId = id()
            status = HostStatusCodec.decode(unary("companionHost/status", rpcId, CompanionMetadataRequests.hostStatus(rpcId)))
        } catch (error: Exception) {
            if (error is CancellationException) throw error
            if (metadataCurrent(lease) && error is TransportFailure && error.kind == TransportFailure.Kind.AUTH_REQUIRED) failure(error, generation)
        }
        if (!metadataCurrent(lease)) return
        val transition = hostObservation.observe(status)
        if (transition.withdraw) {
            nativeReadSerial++; activitySerial++; hostActivityNeedsRead = true
            nativeReadJob?.cancel(); nativeReadJob = null
            mutable.update { it.copy(chatActivity = emptyMap(), nativeGoals = it.nativeGoals.copy(control = null)) }
        }
        mutable.update { it.copy(hostStatusMessage = hostStatusLabel(status?.phase, status?.available)) }
        if (transition.refreshNative || status == null) refreshNativeGoals()
    }

    private suspend fun refreshCatalogClock(lease: MetadataLease) {
        try {
            val rpcId = id()
            val clock = CatalogStateCodec.decode(unary("companion/catalogState", rpcId, CompanionMetadataRequests.catalogState(rpcId)))
            if (!metadataCurrent(lease) || !catalogObservationActive()) return
            if (catalogInvalidation.observe(clock)) {
                interactionHeads = emptyMap(); interactionHeadsViewportEpoch = -1L
                mutable.update { it.copy(interactionCheckHints = emptySet()) }
            }
            refreshCatalogFromClock()
        } catch (error: Exception) {
            if (error is CancellationException) throw error
            if (metadataCurrent(lease) && error is TransportFailure && error.kind == TransportFailure.Kind.AUTH_REQUIRED) failure(error, generation)
        }
    }

    private fun refreshCatalogFromClock() {
        if (metadataLease?.let(::metadataCurrent) != true || !catalogObservationActive()) return
        val token = catalogInvalidation.begin(state.value.busy) ?: return
        if (!refreshCatalog(token)) catalogInvalidation.complete(token, false)
    }

    private suspend fun refreshInteractionHeads(lease: MetadataLease) {
        if (!metadataCurrent(lease) || !catalogObservationActive() || state.value.busy) return
        val viewport = currentCatalogViewport()
        val viewportEpoch = uiLifecycle.viewportEpoch
        if (viewport.isEmpty()) return
        try {
            val rpcId = id()
            val ids = viewport.map { it.sessionId }
            val heads = InteractionHeadsCodec.decode(unary("companion/interactionHeads", rpcId,
                CompanionMetadataRequests.interactionHeads(rpcId, ids)), ids.toSet())
            if (!metadataCurrent(lease) || !catalogViewportCurrent(viewport, viewportEpoch)) return
            interactionHeads = heads
            interactionHeadsViewportEpoch = viewportEpoch
            publishInteractionCheckHints()
        } catch (error: Exception) {
            if (error is CancellationException) throw error
            if (!metadataCurrent(lease) || !catalogViewportCurrent(viewport, viewportEpoch)) return
            interactionHeads = emptyMap()
            publishInteractionCheckHints()
            if (error is TransportFailure && error.kind == TransportFailure.Kind.AUTH_REQUIRED) failure(error, generation)
        }
    }

    private fun publishInteractionCheckHints() {
        val hints = if (metadataLease?.let(::metadataCurrent) == true && catalogObservationActive() && interactionHeadsViewportEpoch == uiLifecycle.viewportEpoch) {
            currentCatalogViewport().filter { row -> hasInteractionCheckHint(interactionHeads[row.sessionId], row.sessionId, row.createdAt) { call ->
                // Any coarse no-retry hit suppresses an ambiguous candidate, never the reverse.
                questionReplies.hasLocalReply(readScopeAuthEpoch, row.sessionId, call) || questions.pending().any {
                    it.key.agentId == row.sessionId && it.key.callId == call && it.delivery != UserQuestionDelivery.ANSWERABLE
                }
            } }.map { it.sessionId }.toSet()
        } else emptySet()
        mutable.update { it.copy(interactionCheckHints = hints) }
    }

    private fun startActivityReconciliation() {
        if (!catalogObservationActive()) return
        if (catalogViewportDebounce?.isActive == true) return
        val viewport = currentCatalogViewport()
        val viewportEpoch = uiLifecycle.viewportEpoch
        if (viewport.isEmpty()) {
            if (activityLoop != null) stopActivityReconciliation()
            return
        }
        if (activityLoop?.isActive == true && activeCatalogViewport == viewport && activeViewportEpoch == viewportEpoch) return
        stopActivityReconciliation()
        activeCatalogViewport = viewport
        activeViewportEpoch = viewportEpoch
        val auth = authGeneration
        val foreground = uiLifecycle.foregroundEpoch
        activityLoop = viewModelScope.launch {
            while (catalogViewportCurrent(viewport, viewportEpoch) && uiLifecycle.accepts(foreground) && auth == authGeneration) {
                refreshNativeActivity(auth, viewport, viewportEpoch)
                refreshMessageHeads(auth, viewport, viewportEpoch)
                delay(10000)
            }
        }
    }

    private suspend fun refreshNativeActivity(auth: Long, viewport: List<CatalogViewportSource>, viewportEpoch: Long) {
        if (hostObservation.suspended || !catalogViewportCurrent(viewport, viewportEpoch)) return
        val serial = ++activitySerial
        val hostEpoch = hostObservation.epoch
        val ids = viewport.map { it.sessionId }
        try {
            val rpcId = id()
            val result = unaryResult("nativeGoals/catalog", rpcId, NativeGoalRequests.catalog(rpcId, ids), allowRefusal = true)
            if (auth != authGeneration || !catalogViewportCurrent(viewport, viewportEpoch) || serial != activitySerial || hostEpoch != hostObservation.epoch || hostObservation.suspended) return
            if (result is RpcResult.Failure) {
                mutable.update { it.copy(chatActivity = emptyMap()) }
                return
            }
            val rows = NativeGoalsCodec.catalog(result.requireValue(), ids.toSet())
            hostActivityNeedsRead = false
            mutable.update { it.copy(chatActivity = rows.filterKeys { key -> key in ownedSessionIds }) }
        } catch (error: Exception) {
            if (error is CancellationException) throw error
            if (serial == activitySerial && catalogViewportCurrent(viewport, viewportEpoch)) mutable.update { it.copy(chatActivity = emptyMap()) }
            if (auth == authGeneration && error is TransportFailure && error.kind == TransportFailure.Kind.AUTH_REQUIRED) failure(error, generation)
        }
    }

    private suspend fun refreshMessageHeads(auth: Long, viewport: List<CatalogViewportSource>, viewportEpoch: Long) {
        if (!catalogViewportCurrent(viewport, viewportEpoch)) return
        val scope = readNamespace ?: return
        val reads = conversationReads ?: return
        val authority = readScopeAuthEpoch
        val foreground = uiLifecycle.foregroundEpoch
        val serial = ++messageHeadsSerial
        val persistedBefore = reads.snapshot()
        fun current(): Boolean = serial == messageHeadsSerial && authority == readScopeAuthEpoch &&
            readNamespace == scope && conversationReads === reads && auth == authGeneration &&
            uiLifecycle.accepts(foreground) && catalogViewportCurrent(viewport, viewportEpoch)
        for (batch in viewport.chunked(ConversationMessageHeadsCodec.MAX_IDS)) {
            if (!current()) return
            val ids = batch.map { it.sessionId }
            try {
                val rpcId = id()
                val result = unaryResult("companion/messageHeads", rpcId, ConversationMessageHeadsRequests.read(rpcId, ids), allowRefusal = true)
                if (!current()) return
                if (result is RpcResult.Failure) {
                    reads.unavailable(scope, viewport.map { it.sessionId })
                    publishUnread()
                    if (persistedBefore != reads.snapshot()) persistReadState()
                    return // Older backends remain honestly unknown, not historical unread-all.
                }
                val heads = ConversationMessageHeadsCodec.read(result.requireValue(), ids.toSet())
                if (!current()) return
                for (chat in batch) {
                    val head = heads.getValue(chat.sessionId)
                    val owned = state.value.chats.any { it.id == chat.sessionId && it.createdAt == chat.createdAt } && chat.sessionId in ownedSessionIds
                    if (owned && head.createdAt == chat.createdAt) reads.observe(scope, head)
                    else reads.unavailable(scope, listOf(chat.sessionId))
                }
                publishUnread()
            } catch (error: Exception) {
                if (error is CancellationException) throw error
                if (!current()) return
                reads.unavailable(scope, ids)
                publishUnread()
                if (error is TransportFailure && error.kind == TransportFailure.Kind.AUTH_REQUIRED) {
                    failure(error, generation)
                    return
                }
            }
        }
        if (current() && persistedBefore != reads.snapshot()) persistReadState()
    }

    override fun acknowledgeVisibleMessage(sessionId: String, generation: Long, transcriptRevision: Long, sequence: Long) {
        val scope = readNamespace ?: return
        val reads = conversationReads ?: return
        val proof = admitted ?: return
        val acceptedJournal = journal ?: return
        val history = acceptedJournal.state()
        val snapshot = state.value
        val createdAt = proof.chat.createdAt ?: return
        if (!uiLifecycle.started || !uiLifecycle.resumed || !uiLifecycle.conversationVisible ||
            !snapshot.authenticated || !snapshot.connected || snapshot.busy || snapshot.presentationPending ||
            generation != this.generation || proof.admission.generation != generation ||
            snapshot.selectedId != sessionId || proof.chat.id != sessionId || !history.ready ||
            history.header?.createdAt != createdAt || transcriptRevision < 0 ||
            transcriptRevision != acceptedJournal.recordsRevision() || transcriptRevision != presentedRecordsRevision ||
            transcriptRevision != snapshot.transcriptRevision || latestPresentation != TranscriptStamp(
                sessionId, generation, transcriptRevision, assistant.state().revision, snapshot.showModelContext)) return
        val displayed = snapshot.richMessages.any { message ->
            message.role == MessageRole.ASSISTANT && message.sourceKind == "model" && !message.streaming &&
                sequence in message.sourceSeqs && message.blocks.any { it is RenderBlock.Text && it.text.isNotBlank() }
        }
        if (!displayed) return
        val record = history.records.firstOrNull { it.seq == sequence && it.type == "assistant/message" } ?: return
        val body = (record.data as? JsonObject)?.get("message") as? JsonObject ?: return
        val source = body["source"] as? JsonObject ?: return
        fun string(value: JsonElement?): String? = (value as? JsonPrimitive)?.takeIf { it.isString }?.content
        if (string(source["kind"]) != "model") return
        val content = body["content"] as? JsonArray ?: return
        if (content.none { block ->
                val value = block as? JsonObject
                string(value?.get("type")) == "text" && !string(value?.get("text")).isNullOrBlank()
            }) return
        reads.setResumed(true)
        if (reads.acknowledge(scope, sessionId, createdAt, sequence)) {
            publishUnread()
            persistReadState()
        }
    }

    override fun loadMore() {
        val proof = admitted ?: return
        val snapshot = journal?.state() ?: return
        val before = snapshot.records.firstOrNull()?.seq ?: return
        if (!snapshot.ready || !snapshot.hasMore || state.value.busy) return
        val epoch = generation
        mutable.update { it.copy(busy = true) }
        viewModelScope.launch {
            try {
                while (true) {
                    val rpcId = id()
                    try {
                        val page = NativeCodec.page(unary("session/page", rpcId, NativeRequests.page(rpcId, proof.admission, snapshot.cursor, before, historyWindow.messages)))
                        if (epoch != generation) return@launch
                        journal?.prepend(page, snapshot.cursor, before, epoch)
                        publish()
                        break
                    } catch (error: ProtocolException) {
                        if (error.code != "json-limit" || !historyWindow.shrink() || epoch != generation) throw error
                    }
                }
                mutable.update { it.copy(busy = false) }
            } catch (error: Exception) { failure(error, epoch) }
        }
    }

    override fun decide(key: ApprovalKey, decision: ApprovalDecision) {
        if (!selectedInteractionEnabled(key.agentId) || key.generation != generation) return
        val reply = approvals.decide(key, decision) ?: return
        publishInteractions()
        reply(reply)
    }
    private fun reply(value: ApprovalReply) {
        if (!approvals.takeForSend(value)) return
        val epoch = value.key.generation
        viewModelScope.launch {
            try {
                if (epoch != generation || !answererVisible()) return@launch
                val rpcId = id()
                interactionResult(rpcId, "\$events/result", NativeRequests.approvalResult(rpcId, value))
                // Void ACK may be a stale no-op. It is not evidence of grant or execution.
            } catch (error: Exception) { failure(error, epoch, "Resposta de aprovação sem confirmação; não será repetida.") }
        }
    }

    private fun selectedInteractionEnabled(agentId: String): Boolean = interactionViewport().canRespond(agentId)

    override fun answerQuestion(key: UserQuestionKey, answer: UserQuestionAnswer) {
        if (!selectedInteractionEnabled(key.agentId) || key.generation != generation ||
            key.kind == UserQuestionKind.CONTINUED && questionProjection.current() == null) return
        if (key.kind == UserQuestionKind.CONTINUED) { prepareContinuedQuestion(key, answer); return }
        if (!questionReplies.canAcquire(readScopeAuthEpoch, key)) return
        val submission = questions.answer(key, answer) ?: return
        check(questionReplies.acquire(readScopeAuthEpoch, key))
        publishInteractions()
        submitQuestion(submission)
    }

    private fun prepareContinuedQuestion(key: UserQuestionKey, answer: UserQuestionAnswer) {
        val proof = admitted ?: return
        val epoch = generation
        val authEpoch = readScopeAuthEpoch
        val source = interactions.sourceToken
        val coordinator = questions
        val requestId = id()
        fun current(): Boolean = epoch == generation && key.generation == epoch && authEpoch == readScopeAuthEpoch && source == interactions.sourceToken &&
            questions === coordinator && key.sourceToken == source && key in displayedContinuedQuestions &&
            selectedInteractionEnabled(key.agentId) && key.agentId == proof.chat.id &&
            questionProjection.current()?.active?.any { it.callId == key.callId && it.state == UserQuestionState.CONTINUED && UserQuestionCodec.digest(it.questions) == key.questionDigest } == true &&
            coordinator.pending().any { it.key == key && it.delivery == UserQuestionDelivery.ANSWERABLE } && questionReplies.canAcquire(authEpoch, key)
        if (!current()) return
        val item = coordinator.pending().firstOrNull { it.key == key } ?: return
        val capturedAnswer = try { UserQuestionCodec.validateAnswer(item.questions, answer) }
            catch (_: Exception) { mutable.update { it.copy(error = "Resposta não enviada: confira os dados da pergunta.") }; return }
        if (!preparations.acquire(proof.chat.id, requestId, epoch)) return
        updateDelivery()
        viewModelScope.launch {
            try {
                applyModelForHumanSubmission(proof, epoch) { current() && preparations.current(proof.chat.id, requestId, epoch) }
                if (!current() || !preparations.current(proof.chat.id, requestId, epoch)) return@launch
                // Model application is not an answer attempt. Only now consume the exact displayed card's authority.
                val submission = coordinator.answer(key, capturedAnswer) ?: return@launch
                check(questionReplies.acquire(authEpoch, key))
                publishInteractions()
                submitQuestion(submission)
            } catch (error: Exception) {
                if (error is CancellationException) throw error
                if (epoch == generation && source == interactions.sourceToken && authEpoch == readScopeAuthEpoch) {
                    mutable.update { it.copy(error = "Resposta não enviada: escolha global sem confirmação. Atualize os modelos antes de tentar novamente.") }
                    if (error is TransportFailure && error.kind == TransportFailure.Kind.AUTH_REQUIRED) failure(error, epoch)
                }
            } finally {
                preparations.release(proof.chat.id, requestId, epoch)
                if (epoch == generation && source == interactions.sourceToken) updateDelivery()
            }
        }
    }

    private fun submitQuestion(submission: UserQuestionSubmission) {
        if (!questions.takeForSend(submission)) return
        val epoch = generation
        val source = interactions.sourceToken
        val coordinator = questions
        val authEpoch = readScopeAuthEpoch
        viewModelScope.launch {
            try {
                if (epoch != generation || source != interactions.sourceToken || !answererVisible()) return@launch
                val rpcId = id()
                val continued = submission.key.kind == UserQuestionKind.CONTINUED
                val method = if (continued) "userQuestions/answer" else "\$events/result"
                val body = if (continued) UserQuestionRequests.continuedAnswer(rpcId, submission) else UserQuestionRequests.eventResult(rpcId, submission)
                val result = interactionResult(rpcId, method, body)
                if (epoch != generation || source != interactions.sourceToken) return@launch
                val accepted = result.questionAcknowledgement(continued)
                coordinator.acknowledge(submission, accepted)
                questionReplies.acknowledge(authEpoch, submission.key, accepted)
            } catch (error: Exception) {
                coordinator.acknowledge(submission, null)
                questionReplies.acknowledge(authEpoch, submission.key, null)
                if (error is CancellationException) throw error
                if (epoch == generation && source == interactions.sourceToken) {
                    mutable.update { it.copy(error = "Resposta sem confirmação; ela não será reenviada.") }
                    if (error is TransportFailure && error.kind == TransportFailure.Kind.AUTH_REQUIRED) failure(error, epoch)
                }
            } finally {
                if (questionReplies.status(authEpoch, submission.key) == UserQuestionDelivery.SUBMITTED) questionReplies.acknowledge(authEpoch, submission.key, null)
                closeTimedClaim(submission.key)
                if (epoch == generation && source == interactions.sourceToken) {
                    publishInteractions()
                    refreshQuestionProjection()
                }
            }
        }
    }

    override fun setQuestionDisplayed(key: UserQuestionKey, displayed: Boolean) {
        if (key.kind == UserQuestionKind.CONTINUED) {
            if (displayed && key.generation == generation && key.sourceToken == interactions.sourceToken && selectedInteractionEnabled(key.agentId)) displayedContinuedQuestions.add(key)
            else displayedContinuedQuestions.remove(key)
            return
        }
        if (!displayed) { closeTimedClaim(key); return }
        if (!selectedInteractionEnabled(key.agentId) || key.kind != UserQuestionKind.TIMED_OPEN) return
        val capability = questions.beginAttachment(key) ?: return
        if (!questions.takeAttachmentForSend(capability)) return
        val streamId = id()
        val claim = TimedQuestionClaim(streamId, capability)
        timedClaims[streamId] = claim
        if (socket?.send(UserQuestionRequests.attachWait(streamId, capability)) != true) {
            closeTimedClaim(key)
        }
    }

    private fun closeTimedClaim(key: UserQuestionKey) {
        timedClaims.values.filter { it.capability.key == key }.toList().forEach { claim ->
            timedClaims.remove(claim.streamId)
            claim.timer?.cancel()
            questions.releaseAttachment(claim.capability)
            socket?.send(NativeRequests.cancelStream(claim.streamId))
        }
    }
    private fun closeTimedClaims() { timedClaims.values.map { it.capability.key }.toList().forEach(::closeTimedClaim) }

    private fun receiveTimedClaim(frame: MuxFrame, claim: TimedQuestionClaim) {
        when (frame) {
            is MuxFrame.Item -> {
                val remaining = UserQuestionCodec.remaining(frame.requireValue())
                if (!questions.acceptRemaining(claim.capability, remaining)) return
                claim.timer = viewModelScope.launch {
                    delay(remaining)
                    if (!selectedInteractionEnabled(claim.capability.key.agentId) || timedClaims[claim.streamId] !== claim) return@launch
                    val timeout = questions.timeout(claim.capability.key) ?: return@launch
                    publishInteractions()
                    submitQuestion(timeout)
                }
            }
            is MuxFrame.End, is MuxFrame.Error -> closeTimedClaim(claim.capability.key)
        }
    }

    private suspend fun interactionResult(rpcId: String, method: String, body: String): RpcResult = coroutineScope {
        val owner = currentCoroutineContext().job
        interactionCalls.add(owner)
        try {
            val raw = transport.rpcCancellableInteraction(method, body)
            currentCoroutineContext().ensureActive()
            withContext(Dispatchers.Default) { NativeCodec.rpc(raw, rpcId) }
        } finally { interactionCalls.remove(owner) }
    }

    private fun publishInteractions() {
        val pendingQuestions = questions.pending().map { item ->
            questionReplies.status(readScopeAuthEpoch, item.key)?.let { item.copy(delivery = it) } ?: item
        }
        val keys = pendingQuestions.map { it.key }.toSet()
        timedClaims.values.filter { it.capability.key !in keys }.map { it.capability.key }.toList().forEach(::closeTimedClaim)
        val projectionCurrent = questionProjection.current() != null
        val selectedId = admitted?.chat?.id
        val attention = interactions.attention(pendingQuestions).let { rows ->
            // A continued question this app cannot present is still the owner's to answer, on the PC.
            if (selectedId == null || !interactions.ready || !questionProjection.unpresentable) rows
            else rows + (selectedId to (rows[selectedId] ?: ConversationAttention()).let { it.copy(unsupported = it.unsupported + 1) })
        }
        mutable.update { it.copy(approvals = approvals.pending(), questions = pendingQuestions,
            chatAttention = attention, answererConnected = interactions.ready && !opening,
            questionProjectionCurrent = projectionCurrent) }
        publishInteractionCheckHints()
    }

    private fun requestInteractionAdmission(agentId: String) {
        if (agentId in admissionJobs || admissionJobs.size >= UserQuestionLimits.PENDING) return
        val epoch = generation
        val source = interactions.sourceToken
        val header = state.value.chats.firstOrNull { it.id == agentId }
        // Register before running: an already-cancelled candidate can finish without suspension.
        admissionJobs[agentId] = viewModelScope.launch(start = kotlinx.coroutines.CoroutineStart.LAZY) {
            val owner = currentCoroutineContext().job
            try {
                admissionConcurrency.withPermit {
                    if (epoch != generation || source != interactions.sourceToken || !answererVisible() || !interactions.needsAdmission(agentId)) return@withPermit
                    val rpcId = id()
                    val proof = NativeCodec.detail(unary("companion/detail", rpcId, NativeRequests.detail(rpcId, agentId)), agentId, epoch)
                    if (epoch != generation || source != interactions.sourceToken || !answererVisible() || !interactions.needsAdmission(agentId)) return@withPermit
                    val current = state.value.chats.firstOrNull { it.id == agentId }
                    if (header != null && (current == null || current.createdAt != header.createdAt)) return@withPermit
                    if (!interactions.admit(proof, epoch, source, current?.createdAt)) interactions.discardCandidate(agentId)
                    publishInteractions()
                }
            } catch (error: Exception) {
                if (error is CancellationException) throw error
                if (epoch == generation && source == interactions.sourceToken) {
                    // No Next, response or body-bearing diagnostic for foreign/unsupported metadata.
                    interactions.discardCandidate(agentId)
                    if (error is TransportFailure && error.kind == TransportFailure.Kind.AUTH_REQUIRED) failure(error, epoch)
                }
            } finally { if (admissionJobs[agentId] === owner) admissionJobs.remove(agentId) }
        }
        admissionJobs[agentId]?.start()
    }

    private fun reconcileQuestionProjection() {
        val proof = admitted ?: return
        if (!eventsReady || !interactions.hasAdmission(proof.chat.id)) return
        val current = questionProjection.current() ?: return
        questionReplies.observe(readScopeAuthEpoch, proof.chat.id, current)
        val reconciled = QuestionProjectionFence.retainingLiveDeliveries(current, proof.chat.id, questions.pending())
        questions.reconcileContinued(proof.chat.id, reconciled, generation, interactions.sourceToken)
    }

    private fun refreshQuestionProjection() {
        val proof = admitted ?: return
        if (!answererVisible() || !eventsReady || journal?.state()?.ready != true) return
        questionProjectionRequested = true
        if (questionProjectionJob?.isActive == true) return
        val epoch = generation
        val source = interactions.sourceToken
        questionProjectionJob = viewModelScope.launch {
            val owner = currentCoroutineContext().job
            try {
                while (questionProjectionRequested && epoch == generation && admitted === proof && source == interactions.sourceToken && answererVisible()) {
                    questionProjectionRequested = false
                    val rpcId = id()
                    val value = unary("session/projections", rpcId, NativeRequests.projections(rpcId, proof.admission))
                    if (epoch != generation || admitted !== proof || source != interactions.sourceToken) return@launch
                    if (value !== JsonNull) questionProjection.accept(QuestionProjectionFence.decode(value)) else questionProjection.unavailable()
                    reconcileQuestionProjection()
                    publishInteractions()
                }
            } catch (error: Exception) {
                if (error is CancellationException) throw error
                if (epoch == generation && source == interactions.sourceToken) {
                    questionProjection.unavailable()
                    publishInteractions()
                    if (error is TransportFailure && error.kind == TransportFailure.Kind.AUTH_REQUIRED) failure(error, epoch)
                }
            } finally { if (questionProjectionJob === owner) questionProjectionJob = null }
        }
    }

    private fun closeInteractionIO() {
        displayedContinuedQuestions.clear()
        closeTimedClaims()
        selectedOpenJob?.cancel(); selectedOpenJob = null
        admissionJobs.values.toList().forEach { it.cancel() }; admissionJobs.clear()
        interactionCalls.toList().forEach { it.cancel() }; interactionCalls.clear()
        questionProjectionJob?.cancel(); questionProjectionJob = null; questionProjectionRequested = false
        questionProjection.clear()
    }

    private fun openSocket(epoch: Long, proof: AdmittedChat?) {
        if (!answererVisible() || epoch != generation || proof != null && admitted !== proof || socket != null || opening) return
        val connectionSerial = ++socketSerial
        eventStream = id(); followStream = id(); opening = true
        val eventsId = eventStream
        val followId = followStream
        val reader = SocketIngress(viewModelScope, eventsId, followId,
            onFrame = { frame -> if (epoch == generation && connectionSerial == socketSerial) incoming(frame, epoch) },
            onFailure = { error ->
                if (connectionSerial != socketSerial) return@SocketIngress
                // A page of compact reasoning streams can exceed the node budget without being corrupt.
                if (error is ProtocolException && error.code == "json-limit" && historyWindow.shrink()) {
                    disconnect(epoch, null, retryable = true, quiet = true)
                } else if (error is IllegalStateException && error.message?.contains("overflow") == true) {
                    disconnect(epoch, error, retryable = true, quiet = false)
                } else disconnect(epoch, error)
            })
        ingress?.close()
        ingress = reader
        val listener = object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                viewModelScope.launch {
                    if (epoch != generation || connectionSerial != socketSerial || !answererVisible()) { webSocket.cancel(); return@launch }
                    opening = false
                    try {
                        check(webSocket.send(NativeRequests.events(eventsId)))
                        if (proof != null) check(webSocket.send(NativeRequests.follow(followId, proof.admission, historyWindow.messages)))
                    } catch (error: Exception) { disconnect(epoch, error, retryable = true) }
                }
            }
            override fun onMessage(webSocket: WebSocket, text: String) {
                reader.offer(text)
            }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                // A refused upgrade would be refused again; an explicit Reconectar re-checks login.
                val refused = response?.code == 401 || response?.code == 403
                viewModelScope.launch { if (connectionSerial == socketSerial) disconnect(epoch, null, retryable = !refused) }
            }
            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                // The peer sends nothing more. Finish the close handshake now: without it OkHttp
                // never reports onClosed and this carrier would look alive while delivering nothing.
                webSocket.close(1000, null)
                viewModelScope.launch { if (connectionSerial == socketSerial) disconnect(epoch, null) }
            }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                viewModelScope.launch { if (connectionSerial == socketSerial) disconnect(epoch, null) }
            }
        }
        socket = try {
            transport.socket(listener)
        } catch (error: Exception) {
            // No saved cookie (AUTH_REQUIRED) or a refused client must neither crash the owner
            // scope nor strand opening=true, which would block every later reopen.
            reader.close()
            if (ingress === reader) ingress = null
            opening = false
            if (error is TransportFailure && error.kind == TransportFailure.Kind.AUTH_REQUIRED) failure(error, epoch)
            else disconnect(epoch, error)
            return
        }
    }

    private fun incoming(decoded: DecodedSocketFrame, epoch: Long) {
        if (!answererVisible() || epoch != generation) return
        val frame = decoded.mux
        timedClaims[frame.streamId]?.let { claim ->
            receiveTimedClaim(frame, claim)
            publishInteractions()
            return
        }
        when (frame) {
            is MuxFrame.Item -> if (frame.streamId == eventStream) {
                decoded.unsupportedWaterfall?.let { item ->
                    // Marked "see it on the PC", never answered, and the carrier stays up.
                    interactions.receiveUnsupported(item.event, item.eventId, item.agentId, epoch)?.let(::requestInteractionAdmission)
                    publishInteractions()
                    return
                }
                val event = requireNotNull(decoded.remoteEvent)
                interactions.receive(event, epoch)?.let(::requestInteractionAdmission)
                if (event is RemoteEventFrame.Ready) {
                    eventsReady = true
                    answererRetry.ready()
                    mutable.update { it.copy(answererUnavailable = false) }
                    reconcileQuestionProjection()
                    refreshQuestionProjection()
                }
                if (event is RemoteEventFrame.Emit) {
                    responses.status(event, epoch)
                    // Emits are broadcast presentation hints: drop a malformed one (and its controls), not the carrier.
                    val rows = try { NativeActivityEvents.receive(state.value.chatActivity, event, ownedSessionIds) }
                        catch (_: ProtocolException) { state.value.chatActivity }
                    val goalState = try { NativeActivityEvents.activation(state.value.nativeGoals, event) }
                        catch (_: ProtocolException) { state.value.nativeGoals.copy(control = null) }
                    if (rows != state.value.chatActivity) activitySerial++
                    if (goalState != state.value.nativeGoals) nativeReadSerial++
                    mutable.update { it.copy(chatActivity = if (hostObservation.suspended || hostActivityNeedsRead) emptyMap() else rows,
                        nativeGoals = if (hostObservation.suspended) goalState.copy(control = null) else goalState) }
                }
                publish()
                if (event is RemoteEventFrame.Emit && event.event == "goal/activation-changed") refreshNativeGoals()
            } else if (frame.streamId == followStream) {
                val followed = requireNotNull(decoded.followed)
                if (followed is FollowFrame.Snapshot) {
                    val sessionId = admitted?.chat?.id ?: error("missing-admission")
                    openings.verify(sessionId, followed)
                }
                val update = journal?.apply(followed, epoch)
                when (update) {
                    is JournalUpdate.RepairRequired -> { disconnect(epoch, null); return }
                    else -> Unit
                }
                when (followed) {
                    is FollowFrame.Snapshot -> {
                        questionProjection.snapshot(followed)
                        reconcileQuestionProjection()
                        nativeReadSerial++
                        val sid = admitted?.chat?.id ?: error("missing-admission")
                        val goals = try { NativeGoalsCodec.snapshot(sid, followed.projections, followed.page.records, followed.cursor) }
                            catch (_: ProtocolException) { NativeGoalsState(sessionId = sid, error = UNPRESENTABLE_GOALS) }
                        mutable.update { it.copy(nativeGoals = goals) }
                        followed.assistantStream?.let { stream ->
                            try { assistant.baseline(stream, epoch, followed.cursor) }
                            catch (_: ProtocolException) { degradeAssistant(epoch, followed.cursor) }
                        }
                        responses.snapshot(followed.page.records, assistant.state(), epoch)
                        admitted?.let { proof -> mutable.update { publishFollowTitle(it, proof, followed, update) } }
                    }
                    is FollowFrame.Assistant -> if (update is JournalUpdate.Assistant && !assistantLiveDegraded) {
                        val result = try { assistant.frame(followed.frame, epoch) } catch (_: ProtocolException) {
                            degradeAssistant(epoch, journal?.state()?.cursor ?: -1L)
                            AssistantUpdate.Ignored
                        }
                        when (result) {
                            AssistantUpdate.RebaselineRequired -> { disconnect(epoch, null); return }
                            AssistantUpdate.Ignored -> Unit
                            else -> responses.assistant(assistant.state(), epoch)
                        }
                    }
                    is FollowFrame.Event -> {
                        if (update is JournalUpdate.Appended) {
                            questionProjection.appended(followed.event)
                            reconcileQuestionProjection()
                            responses.event(followed.event, epoch)
                            val before = state.value.nativeGoals
                            // Goal/TODO are presentation; an over-limit change withholds controls, not the carrier.
                            val after = try { NativeGoalsCodec.event(before, followed.event) } catch (_: ProtocolException) {
                                before.copy(knowledge = NativeKnowledge.UNKNOWN, control = null, asOfSeq = followed.event.seq, error = UNPRESENTABLE_GOALS)
                            }
                            if (after != before) {
                                // Journal progress is reconciled against the RPC cut, not a new request.
                                // Incrementing here lets every streamed token retire an in-flight read.
                                mutable.update { it.copy(nativeGoals = after) }
                                val sid = admitted?.chat?.id
                                if (sid != null && sid in ownedSessionIds && state.value.authenticated) {
                                    NativeGoalCompletion.payload(sid, before, after, followed.event)?.let { payload ->
                                        GoalNotifications.publishNativeCompletion(getApplication(), payload, authGeneration)
                                    }
                                }
                            }
                        }
                        val durable = try { assistant.durable(followed.event, epoch) } catch (_: ProtocolException) {
                            degradeAssistant(epoch, journal?.state()?.cursor ?: -1L)
                            AssistantUpdate.Ignored
                        }
                        if (durable != AssistantUpdate.Ignored) responses.assistant(assistant.state(), epoch)
                    }
                }
                publish()
                if (followed is FollowFrame.Snapshot || followed is FollowFrame.Event && update is JournalUpdate.Appended &&
                    (followed.event.type.startsWith("tool/") || followed.event.type in setOf("request/header", "user/message", "turn/end"))) refreshQuestionProjection()
                if (followed is FollowFrame.Snapshot || followed is FollowFrame.Event &&
                    followed.event.type in setOf("goal/change", "todo/write", "turn/start", "turn/end", "user/message")) refreshNativeGoals()
            }
            // A stream the host ended may reopen; one it refused with an error waits for Reconectar.
            is MuxFrame.End, is MuxFrame.Error -> if (frame.streamId == followStream || frame.streamId == eventStream) {
                disconnect(epoch, null, retryable = frame is MuxFrame.End)
            }
        }
    }

    /**
     * The live assistant preview is presentation only. If it exceeds a limit or uses new vocabulary,
     * drop it for this carrier instead of the whole connection (whose reopen would hit the same
     * baseline). The durable journal still delivers the committed message and every approval.
     */
    private fun degradeAssistant(epoch: Long, cursor: Long) {
        assistantLiveDegraded = true
        assistant = AssistantAssembler(epoch).also { it.baseline(JsonObject(mapOf("revision" to JsonPrimitive(0))), epoch, cursor) }
        responses.assistant(assistant.state(), epoch)
        mutable.update { it.copy(error = "Prévia ao vivo indisponível para esta resposta; o texto aparece quando ela terminar (ou veja no PC).") }
    }

    private fun publish() {
        publishInteractions()
        val history = journal?.state() ?: return
        val assembly = assistant.state()
        admitted?.chat?.id?.let { sessionId ->
            if (history.ready && assembly.ready) {
                openings.confirmed(sessionId, history.cursor)
                submissions.observe(sessionId, history.records)
            }
        }
        // Authority effects above and these control facts stay on the serialized owner dispatcher.
        mutable.update { it.copy(response = responses.state(),
            hasMore = history.hasMore, connected = history.ready && eventsReady && assembly.ready && !opening,
            status = if (history.ready && eventsReady && assembly.ready) "Conectado" else "Carregando histórico") }
        updateDelivery()
        maybeSubmitFirstDraft()
        if (history.ready && assembly.ready) {
            val sessionId = admitted?.chat?.id ?: return
            val epoch = generation
            val source = TranscriptSource(sessionId, epoch, requireNotNull(journal).recordsRevision(), history.records, assembly,
                showModelContext = state.value.showModelContext)
            if (source.stamp != latestPresentation) {
                latestPresentation = source.stamp
                mutable.update { it.copy(presentationPending = true) }
            }
            val worker = presenter ?: TranscriptPresenter(viewModelScope,
                onPresentation = { input, frame, exact ->
                    if (generation == epoch && state.value.selectedId == sessionId && input.showModelContext == state.value.showModelContext) {
                        presentedRecordsRevision = input.recordsRevision
                        mutable.update { it.copy(messages = frame.messages, richMessages = frame.richMessages,
                            transcriptRevision = input.recordsRevision,
                            streamingText = frame.streamingText, presentationPending = !exact) }
                        projectionChanges.value++
                    }
                }, onFailure = { error -> disconnect(epoch, error) }).also { presenter = it }
            worker.submit(source)
        }
    }

    private fun closePresentation() {
        ingress?.close(); ingress = null
        presenter?.close(); presenter = null
        latestPresentation = null
        presentedRecordsRevision = -1
        mutable.update { it.copy(transcriptRevision = -1) }
        projectionChanges.value++
    }

    private fun updateDelivery() {
        if (state.value.isNewDraft && state.value.selectedId == null) {
            val local = newChatDraft.snapshot()
            mutable.update { it.copy(resendFiles = 0,
                pendingPrompt = if (local.pending) local.text else null,
                delivery = when {
                local.pending -> DeliveryStatus.SENDING
                local.phase == NewChatDraftController.Phase.CREATE_UNKNOWN -> DeliveryStatus.UNKNOWN
                else -> DeliveryStatus.NONE
            }) }
            return
        }
        val sessionId = state.value.selectedId ?: return
        val entry = submissions.entry(sessionId)
        if (entry != null && entry.status == DeliveryStatus.ADMITTED && consumedDrafts.add(entry.requestId)) {
            val sentFiles = fileRequestSelections.remove(entry.requestId).orEmpty().toSet()
            if (sentFiles.isNotEmpty()) {
                selectedFiles = selectedFiles.filterNot { it.selectionId in sentFiles }
                if (selectedFiles.isEmpty()) filesNeedReselect = false
                publishSelectedFiles()
            }
            if (drafts[sessionId] == entry.text) drafts[sessionId] = ""
            mutable.update { if (it.draft == entry.text) it.copy(draft = "") else it }
        }
        val pending = firstDraft
        val preparingFirst = pending != null && pending.sessionId == sessionId && pending.generation == generation &&
            newChatDraft.current(pending.ticket, generation, sessionId)
        val userMessageDelivered = state.value.richMessages.any { it.role == MessageRole.USER }
        val candidatePrompt = (if (preparingFirst) pending?.ticket?.literal else null)
            ?: entry?.takeIf { it.status == DeliveryStatus.SENDING || it.status == DeliveryStatus.ADMITTED }?.text
        val sendingPrompt = if (userMessageDelivered) null else (candidatePrompt ?: state.value.pendingPrompt)
        val uncertainFiles = submissions.entry(sessionId)?.takeIf { it.status == DeliveryStatus.UNKNOWN }?.files?.size ?: 0
        mutable.update { it.copy(resendFiles = uncertainFiles,
            pendingPrompt = sendingPrompt,
            delivery = if (preparingFirst || preparations.active(sessionId)) DeliveryStatus.SENDING else submissions.status(sessionId)) }
    }

    /** Hiding panes revokes only the answerer; settings/model reads keep their own generation. */
    private fun suspendAnswerer() {
        retireFileSend()
        answererRetryJob?.cancel(); answererRetryJob = null
        val wasOpeningSelected = selectedOpenJob?.isActive == true
        socketSerial++
        closeInteractionIO()
        closePresentation()
        socket?.cancel(); socket = null
        eventsReady = false; opening = false; admitted = null; journal = null
        interactions.reset(generation, readScopeAuthEpoch)
        mutable.update { it.copy(connected = false, busy = if (wasOpeningSelected) false else it.busy, answererConnected = false,
            answererUnavailable = false, approvals = emptyList(), questions = emptyList(),
            chatAttention = emptyMap(), questionProjectionCurrent = false, streamingText = null, presentationPending = false,
            richMessages = it.richMessages.map { message -> if (message.streaming) message.copy(streaming = false, interrupted = true) else message },
            status = "Conversa suspensa") }
    }

    private fun resetConnection(preserveDraft: NewChatDraftController.Ticket? = null) {
        // A deliberate reset owns its own reopen; a pending automatic one would only race it.
        answererRetryJob?.cancel(); answererRetryJob = null
        stopActivityReconciliation()
        socketSerial++
        closeInteractionIO()
        val pending = firstDraft
        val preserving = preserveDraft != null && pending?.ticket === preserveDraft && newChatDraft.current(preserveDraft, generation)
        if (!preserving) {
            retireFileSend()
            newChatDraft.interrupt(generation)
            firstDraft = null
        }
        nativeReadSerial++
        nativeReadJob?.cancel(); nativeReadJob = null
        preparations.interrupted(generation)
        submissions.interrupted(generation)
        generation++
        closePresentation()
        responses.invalidate(generation)
        images.clear()
        mutable.update { it.copy(connectionGeneration = generation, response = responses.state(), settings = it.settings.copy(loading = false),
            nativeGoals = NativeGoalsState(), chatActivity = emptyMap(), connected = false,
            approvals = emptyList(), questions = emptyList(), chatAttention = emptyMap(), answererConnected = false,
            answererUnavailable = false, questionProjectionCurrent = false) }
        modelCatalogSerial++
        catalogSerial++
        socket?.cancel(); socket = null
        eventsReady = false; opening = false; admitted = null; journal = null
        interactions.reset(generation, readScopeAuthEpoch)
    }
    /** [retryable] false: a data error or refused upgrade, which only an explicit Reconectar retries. */
    private fun disconnect(epoch: Long, error: Exception?, retryable: Boolean = error == null, quiet: Boolean = false) {
        if (error != null) CompanionLog.e("CompanionVM", "disconnect epoch=$epoch retryable=$retryable quiet=$quiet: ${error.message}", error)
        if (epoch != generation) return
        retireFileSend()
        newChatDraft.interrupt(epoch)
        firstDraft = null
        nativeReadSerial++
        nativeReadJob?.cancel(); nativeReadJob = null
        // Losing a UI carrier is not logout or withdrawal of separately authorized push delivery.
        stopActivityReconciliation()
        closeInteractionIO()
        preparations.interrupted(epoch)
        submissions.interrupted(epoch)
        generation++ // Fence queued callbacks and answers from the disconnected socket.
        closePresentation()
        responses.invalidate(generation)
        images.clear()
        mutable.update { it.copy(connectionGeneration = generation, response = responses.state(),
            nativeGoals = it.nativeGoals.copy(knowledge = NativeKnowledge.UNKNOWN, control = null, pending = false), chatActivity = emptyMap()) }
        socketSerial++
        socket?.cancel(); socket = null
        eventsReady = false; opening = false; admitted = null; journal = null
        interactions.reset(generation, readScopeAuthEpoch)
        mutable.update { it.copy(connected = false, busy = false, approvals = emptyList(), questions = emptyList(),
            chatAttention = emptyMap(), answererConnected = false, answererUnavailable = true, questionProjectionCurrent = false,
            streamingText = null, presentationPending = false,
            richMessages = it.richMessages.map { message -> if (message.streaming) message.copy(streaming = false, interrupted = true) else message },
            status = if (quiet) "Abrindo um trecho menor do histórico" else "Desconectado",
            error = when {
                quiet -> null
                error == null -> "Conexão encerrada. Reconecte para obter um histórico confirmado."
                error is IllegalStateException && error.message?.contains("overflow") == true ->
                    "Saturação de buffer de mensagens. Reconectando…"
                else -> "Dados não suportados. Reconecte sem reenviar mensagens."
            }) }
        updateDelivery()
        scheduleAnswererReconnect(retryable)
    }

    /**
     * While an answerer pane is visible, reopen a lost carrier with bounded backoff, so approvals and
     * questions do not stop silently. This only re-reads (detail + follow/events); it never
     * replays a prompt, answer or control. The gateway re-delivers pending waterfalls on reopen.
     */
    private fun scheduleAnswererReconnect(retryable: Boolean) {
        answererRetryJob?.cancel(); answererRetryJob = null
        if (!answererVisible()) return
        val wait = answererRetry.failed(retryable) ?: return
        val epoch = generation
        answererRetryJob = viewModelScope.launch {
            delay(wait)
            if (epoch != generation || socket != null || opening || !answererVisible()) return@launch
            // Another read (e.g. a catalog refresh) owns busy right now; try again on the next step.
            if (state.value.busy) scheduleAnswererReconnect(retryable = true) else reconcileAnswererVisibility()
        }
    }
    private suspend fun unary(method: String, rpcId: String, body: String): JsonElement = unaryResult(method, rpcId, body).requireValue()
    private suspend fun unaryResult(method: String, rpcId: String, body: String, allowRefusal: Boolean = false): RpcResult = coroutineScope {
        val readOnly = method in FOREGROUND_READ_METHODS
        val foreground = uiLifecycle.foregroundEpoch
        val owner = currentCoroutineContext().job
        if (readOnly) {
            if (!uiLifecycle.accepts(foreground)) throw CancellationException("app-not-visible")
            foregroundReads.add(owner)
        }
        try {
            val raw = if (readOnly) transport.rpcCancellableRead(method, body)
                else withContext(Dispatchers.IO) { transport.rpc(method, body) }
            val result = withContext(Dispatchers.Default) { NativeCodec.rpc(raw, rpcId) }
            currentCoroutineContext().ensureActive()
            if (readOnly && !uiLifecycle.accepts(foreground)) throw CancellationException("app-visibility-changed")
            if (result is RpcResult.Failure && !allowRefusal) throw IllegalStateException("remote-refusal")
            result
        } finally {
            if (readOnly) foregroundReads.remove(owner)
        }
    }
    private fun failure(error: Exception, epoch: Long, message: String? = null) {
        if (error is CancellationException) throw error
        if (epoch != generation) return
        val auth = error is TransportFailure && error.kind == TransportFailure.Kind.AUTH_REQUIRED
        val storage = error is CookieStoreFailure || error is TransportFailure && error.kind == TransportFailure.Kind.STORAGE
        if (auth) {
            val (readEpoch, previousReadScope) = revokeReadAuthority()
            viewModelScope.launch { clearReadAuthority(readEpoch, previousReadScope) }
            revokeNotificationAuthority(); resetConnection(); transport.close()
        }
        mutable.update { it.copy(busy = false, authenticated = if (auth) false else it.authenticated,
            chats = if (auth) emptyList() else it.chats, title = if (auth) "Conversas" else it.title,
            savedLogin = if (auth) false else storage || it.savedLogin,
            connected = if (auth) false else it.connected, error = message ?: if (auth) "Entre novamente com o link privado."
            else if (storage) "Não foi possível acessar o login salvo. Tente novamente ou esqueça-o localmente."
            else "Operação indisponível ou dados não suportados.") }
    }
    override fun onCleared() { revokeReadAuthority(); revokeNotificationAuthority(); resetConnection(); transport.close() }
    private companion object {
        fun id(): String = UUID.randomUUID().toString()
        const val UNPRESENTABLE_GOALS = "Goal ou TODO desta conversa não pode ser exibido aqui; veja no PC."
        val FOREGROUND_READ_METHODS = dev.alex.dsh.companion.net.NativeRpcPolicy.foregroundReads
        val MODEL_REFUSALS = setOf("model-invalid-request", "model-unavailable", "model-read-only", "model-default-conflict", "model-catalog-unavailable", "model-catalog-limit")
            .map { "companion/$it" }.toSet()
        val DELETE_REFUSALS = setOf("delete-invalid-request", "delete-unsupported", "delete-busy", "delete-changed", "delete-unavailable", "foreign-session", "invalid-request")
            .map { "companion/$it" }.toSet()
    }
}

/** Never let cancellation/failure strand the first screen or a stale restore release a newer state. */
internal suspend fun restoringStartup(
    initial: Boolean,
    current: () -> Boolean,
    finish: () -> Unit,
    restore: suspend () -> Unit,
) {
    try {
        restore()
    } finally {
        if (initial && current()) finish()
    }
}
