package dev.alex.dsh.companion.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.animation.core.tween
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.gestures.animateScrollBy
import androidx.compose.foundation.gestures.scrollBy
import androidx.compose.foundation.interaction.collectIsDraggedAsState
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.text.selection.DisableSelection
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalAutofill
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.LocalTextToolbar
import androidx.compose.ui.platform.LocalViewConfiguration
import androidx.compose.ui.platform.TextToolbarStatus
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.dismiss as semanticDismiss
import androidx.compose.ui.semantics.paneTitle
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import dev.alex.dsh.companion.protocol.ApprovalDecision
import dev.alex.dsh.companion.protocol.ApprovalPresentation
import dev.alex.dsh.companion.protocol.CompanionChat
import dev.alex.dsh.companion.protocol.NativeGoalsState
import dev.alex.dsh.companion.protocol.NativeKnowledge
import dev.alex.dsh.companion.protocol.UserQuestionDelivery
import dev.alex.dsh.companion.protocol.UserQuestionKind
import dev.alex.dsh.companion.ui.questions.UserQuestionCard
import dev.alex.dsh.companion.notifications.PushUiStatus
import dev.alex.dsh.companion.media.OwnedImageCard
import dev.alex.dsh.companion.delivery.ResponsePhase
import dev.alex.dsh.companion.render.ImageReference
import dev.alex.dsh.companion.render.TranscriptCellBody
import dev.alex.dsh.companion.ui.loading.MaidLoader
import dev.alex.dsh.companion.ui.loading.MockFrameStage
import dev.alex.dsh.companion.ui.gestures.CompanionRoute
import dev.alex.dsh.companion.ui.gestures.CompanionRoutes
import dev.alex.dsh.companion.ui.gestures.FullscreenEdgeNav
import dev.alex.dsh.companion.ui.premium.LocalWorkspaceDismiss
import dev.alex.dsh.companion.ui.premium.PremiumTheme
import dev.alex.dsh.companion.ui.premium.workspaceGestureExcluded
import dev.alex.dsh.companion.ui.render.TranscriptCellContent
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.Locale
import kotlinx.coroutines.flow.collectLatest

@Composable
fun CompanionTheme(content: @Composable () -> Unit) {
    PremiumTheme(content = content)
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CompanionScreen(state: CompanionUiState, actions: UiActions,
    pushStatus: PushUiStatus? = null,
    onNotificationOptIn: () -> Unit = {},
    onNotificationOff: () -> Unit = {},
) {
    // Latch explicit account actions even when a callback has not published busy yet.
    // A completed busy cycle or changed login state allows another intentional attempt.
    var accountActionSent by remember(state.authenticated, state.savedLogin, state.busy) { mutableStateOf(false) }
    val accountActionsEnabled = !state.busy && state.delivery != DeliveryStatus.SENDING && !accountActionSent
    val restoreLogin: () -> Unit = {
        if (accountActionsEnabled && !accountActionSent) {
            accountActionSent = true
            actions.restoreLogin()
        }
    }
    val logout: () -> Unit = {
        if (accountActionsEnabled && !accountActionSent) {
            accountActionSent = true
            actions.logout()
        }
    }
    var settingsOpen by remember(state.authenticated) { mutableStateOf(false) }
    var forward by remember(state.authenticated) { mutableStateOf(emptyList<CompanionRoute>()) }
    var navEpoch by remember(state.authenticated) { mutableIntStateOf(0) }
    var seenEpoch by remember(state.authenticated) { mutableIntStateOf(0) }
    var parkedTitles by remember(state.authenticated) { mutableStateOf(emptyMap<String, String>()) }
    val resumed = rememberWorkspaceResumed()
    val chatRoute = CompanionRoutes.chat(state.selectedId, state.isNewDraft)
    val back = when {
        !state.authenticated -> listOf(CompanionRoute.Catalog)
        settingsOpen -> listOf(CompanionRoute.Catalog, CompanionRoute.Settings)
        chatRoute != null -> listOf(CompanionRoute.Catalog, chatRoute)
        else -> listOf(CompanionRoute.Catalog)
    }
    val top = back.last()
    // Visibility follows the settled top, not the finger. A parked chat is not the open route.
    val catalogVisible = state.authenticated && top == CompanionRoute.Catalog
    val conversationVisible = state.authenticated && top is CompanionRoute.Chat
    val workspaceOwner = remember(actions) { Any() }
    // One lease owns both panes, including the retained catalog underneath the workspace.
    // Foreground state is owned separately by lifecycle hooks, not a cached catalog snapshot.
    DisposableEffect(workspaceOwner, state.authenticated, top, resumed) {
        actions.setWorkspaceVisibility(workspaceOwner, catalogVisible, conversationVisible && resumed)
        onDispose { actions.clearWorkspaceVisibility(workspaceOwner) }
    }
    val presentations = remember(state.authenticated) { dev.alex.dsh.companion.ui.premium.ConversationPresentationCache() }
    androidx.compose.runtime.DisposableEffect(presentations) { onDispose { presentations.clear() } }
    LaunchedEffect(presentations, state.lastDeletedChatId) { state.lastDeletedChatId?.let(presentations::remove) }
    LaunchedEffect(chatRoute, state.title) {
        if (chatRoute != null && state.title.isNotBlank()) parkedTitles = parkedTitles + (chatRoute.key to state.title)
    }
    // External selection (notification, fixture) must not leave a stale forward target.
    LaunchedEffect(back, navEpoch, state.authenticated) {
        if (!state.authenticated || navEpoch != seenEpoch) {
            seenEpoch = navEpoch
            return@LaunchedEffect
        }
        forward = when {
            top != CompanionRoute.Catalog && top == forward.lastOrNull() -> forward.dropLast(1)
            top != CompanionRoute.Catalog -> emptyList()
            else -> forward
        }
    }
    val notePush: (CompanionRoute) -> Unit = { route ->
        navEpoch++
        forward = if (forward.lastOrNull() == route) forward.dropLast(1) else emptyList()
    }
    val openSettings: () -> Unit = {
        if (accountActionsEnabled) {
            notePush(CompanionRoute.Settings)
            settingsOpen = true
            actions.refreshModelCatalog()
        }
    }
    val openChat: (String) -> Unit = { id ->
        notePush(CompanionRoute.Chat("id:$id"))
        actions.select(id)
    }
    val openDraft: () -> Unit = {
        notePush(CompanionRoute.Chat("draft"))
        actions.create()
    }
    val commitBack: () -> Boolean = {
        val leaving = back.last()
        if (leaving == CompanionRoute.Catalog) false else {
            navEpoch++
            forward = forward + leaving
            when (leaving) {
                CompanionRoute.Settings -> settingsOpen = false
                is CompanionRoute.Chat -> actions.back()
                CompanionRoute.Catalog -> Unit
            }
            true
        }
    }
    val commitForward: () -> Boolean = {
        val next = forward.lastOrNull()
        val blocked = state.busy || state.delivery == DeliveryStatus.SENDING || state.delivery == DeliveryStatus.UNKNOWN
        if (next == null || (next is CompanionRoute.Chat && blocked)) false else {
            navEpoch++
            forward = forward.dropLast(1)
            when (next) {
                CompanionRoute.Settings -> {
                    settingsOpen = true
                    actions.refreshModelCatalog()
                }
                is CompanionRoute.Chat -> {
                    val id = CompanionRoutes.sessionId(next)
                    if (id != null) actions.select(id) else actions.create()
                }
                CompanionRoute.Catalog -> Unit
            }
            true
        }
    }
    var catalog by remember(state.authenticated) { mutableStateOf(state) }
    SideEffect {
        catalog = if (catalogVisible) state else retainedCatalog(catalog, state)
    }
    if (!state.authenticated) {
        CompanionPane(state, actions, accountActionsEnabled, restoreLogin, logout, false, Modifier.fillMaxSize(), presentations, workspaceOwner)
    } else {
        val holder = rememberSaveableStateHolder()
        val knownKeys = remember { mutableSetOf<String>() }
        val liveKeys = remember(back, forward) { (back + forward).map { CompanionRoutes.key(it) }.toSet() }
        LaunchedEffect(liveKeys) {
            val stale = knownKeys - liveKeys
            stale.forEach { holder.removeState(it) }
            knownKeys.removeAll(stale)
            knownKeys.addAll(liveKeys)
        }
        FullscreenEdgeNav(
            stack = back,
            nextForward = forward.lastOrNull(),
            keyOf = CompanionRoutes::key,
            onBack = commitBack,
            onForward = commitForward,
            onRootBack = {
                if (forward.isNotEmpty()) {
                    navEpoch++
                    forward = emptyList()
                }
            },
        ) { route ->
            holder.SaveableStateProvider(CompanionRoutes.key(route)) {
                when (route) {
                    CompanionRoute.Catalog -> PremiumTheme {
                        CompanionPane(catalog, actions, accountActionsEnabled, restoreLogin, logout, false, Modifier.fillMaxSize(),
                            presentations, workspaceOwner, visible = catalogVisible && state.appStarted && state.appResumed && resumed,
                            openSettings = openSettings, onOpenChat = openChat, onCreate = openDraft)
                    }
                    CompanionRoute.Settings -> PremiumTheme {
                        CompanionPane(state, actions, accountActionsEnabled, restoreLogin, logout, false, Modifier.fillMaxSize(),
                            presentations, workspaceOwner, visible = false, settingsMode = true,
                            pushStatus = pushStatus, onNotificationOptIn = onNotificationOptIn, onNotificationOff = onNotificationOff)
                    }
                    is CompanionRoute.Chat -> PremiumTheme(plum = true) {
                        if (CompanionRoutes.matches(route, state.selectedId, state.isNewDraft)) {
                            CompanionPane(state, actions, accountActionsEnabled, restoreLogin, logout, true, Modifier.fillMaxSize(),
                                presentations, workspaceOwner, visible = conversationVisible && resumed)
                        } else {
                            Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
                                MockFrameStage()
                            }
                        }
                    }
                }
            }
        }
    }
}

/** collectAsStateWithLifecycle can stop before the VM's final PAUSE/STOP state is collected. */
@Composable
private fun rememberWorkspaceResumed(): Boolean {
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    var resumed by remember(lifecycle) { mutableStateOf(lifecycle.currentState == Lifecycle.State.RESUMED) }
    DisposableEffect(lifecycle) {
        val observer = LifecycleEventObserver { _, _ -> resumed = lifecycle.currentState == Lifecycle.State.RESUMED }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer) }
    }
    return resumed
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun CompanionPane(state: CompanionUiState, actions: UiActions, accountActionsEnabled: Boolean,
    restoreLogin: () -> Unit, logout: () -> Unit, chat: Boolean, modifier: Modifier,
    presentations: dev.alex.dsh.companion.ui.premium.ConversationPresentationCache,
    workspaceOwner: Any,
    visible: Boolean = true, settingsMode: Boolean = false, openSettings: () -> Unit = {},
    onOpenChat: (String) -> Unit = actions::select, onCreate: () -> Unit = actions::create,
    pushStatus: PushUiStatus? = null, onNotificationOptIn: () -> Unit = {}, onNotificationOff: () -> Unit = {},
    origin: (Rect) -> Unit = {},
) {
    val dismiss = LocalWorkspaceDismiss.current
    val keyboard = LocalSoftwareKeyboardController.current
    val routeSemantics = when {
        chat -> Modifier.testTag("chat-pane").semantics {
            paneTitle = state.title
            semanticDismiss(label = "Voltar para conversas") { keyboard?.hide(); dismiss(); true }
        }
        settingsMode -> Modifier.testTag("settings-pane").semantics {
            paneTitle = "Configurações"
            semanticDismiss(label = "Voltar para conversas") { keyboard?.hide(); dismiss(); true }
        }
        else -> Modifier
    }
    Scaffold(
        modifier = modifier.fillMaxSize().then(routeSemantics),
        containerColor = MaterialTheme.colorScheme.background,
        contentWindowInsets = WindowInsets.safeDrawing,
        topBar = {
            if (!state.authenticated || settingsMode) {
                TopAppBar(
                    colors = TopAppBarDefaults.topAppBarColors(containerColor = Color.Transparent),
                    title = {
                        Column {
                            Text(if (settingsMode) "Configurações" else if (chat) state.title else "Companion", style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            if (!chat && !settingsMode) Text(state.status, style = MaterialTheme.typography.labelSmall)
                        }
                    },
                )
            }
        },
    ) { insets ->
        Column(Modifier.fillMaxSize().padding(insets).consumeWindowInsets(insets).imePadding()) {
            // The retained catalog does not grow a global loader merely because a route closes.
            if (state.busy && (chat || !state.authenticated)) Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                MaidLoader(active = visible)
                Text(state.status, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            state.error?.let { error ->
                Surface(color = MaterialTheme.colorScheme.errorContainer, modifier = Modifier.fillMaxWidth()) {
                    SelectionContainer { Text(error, modifier = Modifier.padding(16.dp), color = MaterialTheme.colorScheme.onErrorContainer) }
                }
            }
            if (state.authenticated) state.hostStatusMessage?.let { message ->
                dev.alex.dsh.companion.ui.catalog.HostMetadataBanner(message, state.appStarted && state.appResumed && !state.busy, actions::refreshMetadata)
            }
            if (state.showConnectionWarning) {
                Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text("Conexão interrompida", modifier = Modifier.weight(1f), style = MaterialTheme.typography.bodySmall)
                    TextButton(onClick = actions::reconnect, enabled = !state.busy, modifier = Modifier.heightIn(min = 48.dp)) { Text("Reconectar") }
                }
            }
            // The retained catalog under an open chat must not repeat the chat's own warning.
            if (state.showAnswererWarning && visible) {
                Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp).testTag("answerer-unavailable"), verticalAlignment = Alignment.CenterVertically) {
                    Text("Aprovações e perguntas indisponíveis", modifier = Modifier.weight(1f), style = MaterialTheme.typography.bodySmall)
                    TextButton(onClick = actions::reconnect, enabled = !state.busy, modifier = Modifier.heightIn(min = 48.dp)) { Text("Reconectar") }
                }
            }
            when {
                !state.authenticated -> LoginScreen(state.busy, state.savedLogin, actions::login, accountActionsEnabled, restoreLogin, logout, Modifier.weight(1f))
                settingsMode -> dev.alex.dsh.companion.ui.settings.SettingsScreen(
                    state.settings.copy(logoutEnabled = accountActionsEnabled,
                        logoutBlockedReason = if (accountActionsEnabled) null else "Aguarde a operação em andamento."),
                    actions::refreshModelCatalog, actions::chooseDefaultModel, logout, Modifier.weight(1f), notifications = {
                        pushStatus?.let { dev.alex.dsh.companion.ui.settings.GoalNotificationSettings(it, onNotificationOptIn, onNotificationOff) }
                    }, display = {
                        dev.alex.dsh.companion.ui.settings.ModelContextSetting(state.showModelContext, actions::setShowModelContext)
                    })
                !chat -> ChatsScreen(state, actions, Modifier.weight(1f), origin, openSettings, onOpenChat, onCreate, accountActionsEnabled, visible, workspaceOwner)
                else -> ChatScreen(state, actions, presentations, Modifier.weight(1f), visible)
            }
        }
    }
}

@OptIn(ExperimentalComposeUiApi::class)
@Composable
private fun LoginScreen(
    busy: Boolean,
    savedLogin: Boolean,
    login: (String) -> Unit,
    accountActionsEnabled: Boolean,
    restoreLogin: () -> Unit,
    logout: () -> Unit,
    modifier: Modifier = Modifier,
) {
    // Deliberately not rememberSaveable: login secrets never enter saved state.
    var link by remember { mutableStateOf("") }
    val keyboard = LocalSoftwareKeyboardController.current
    Column(modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Text("Seu companion, no celular", style = MaterialTheme.typography.headlineSmall)
        Text("Use o link privado de conexão fornecido pelo DSH. Ele fica oculto e é apagado deste campo ao conectar.")
        if (savedLogin) {
            OutlinedButton(onClick = restoreLogin, enabled = accountActionsEnabled, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("Tentar login salvo") }
            TextButton(onClick = logout, enabled = accountActionsEnabled, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("Esquecer login") }
            Text("Esquecer apaga somente o login salvo neste aparelho; não revoga o acesso no servidor.", style = MaterialTheme.typography.bodySmall)
        }
        CompositionLocalProvider(LocalAutofill provides null) {
            OutlinedTextField(
                value = link,
                onValueChange = { if (it.length <= 4096) link = it },
                label = { Text("Link privado de conexão") },
                modifier = Modifier.fillMaxWidth(),
                enabled = !busy,
                singleLine = true,
                visualTransformation = PasswordVisualTransformation(),
                keyboardOptions = KeyboardOptions(autoCorrectEnabled = false, keyboardType = KeyboardType.Password, imeAction = ImeAction.Done),
            )
        }
        Button(
            onClick = {
                val submitted = link
                link = ""
                keyboard?.hide()
                login(submitted)
            },
            enabled = !busy && link.isNotBlank(),
            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
        ) { Text(if (busy) "Conectando…" else "Conectar") }
        Text("Não compartilhe esse link. Este app não abre outras sessões ou escolhe outro perfil.", style = MaterialTheme.typography.bodySmall)
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ChatsScreen(state: CompanionUiState, actions: UiActions, modifier: Modifier = Modifier,
    origin: (Rect) -> Unit = {}, openSettings: () -> Unit, onOpenChat: (String) -> Unit, onCreate: () -> Unit, accountActionsEnabled: Boolean,
    visible: Boolean,
    workspaceOwner: Any,
) {
    val list = rememberLazyListState()
    val currentViewportEnabled by rememberUpdatedState(visible && state.appStarted && state.appResumed)
    val catalogIds = remember(state.chats) { state.chats.mapTo(mutableSetOf()) { it.id } }
    val currentCatalogIds by rememberUpdatedState(catalogIds)
    LaunchedEffect(actions, workspaceOwner, list) {
        // Lazy prefetch may compose cards outside the viewport. Only intersecting measured rows
        // authorize metadata work; layout/visibility changes are events, not a polling clock.
        snapshotFlow {
            if (!currentViewportEnabled) emptyList() else {
                val layout = list.layoutInfo
                layout.visibleItemsInfo.asSequence()
                    .filter { it.offset < layout.viewportEndOffset && it.offset + it.size > layout.viewportStartOffset }
                    .sortedBy { it.index }
                    .mapNotNull { it.key as? String }
                    .filter { it in currentCatalogIds }
                    .distinct().take(20).toList()
            }
        }.collectLatest { actions.setCatalogViewport(workspaceOwner, it) }
    }
    DisposableEffect(actions, workspaceOwner) {
        onDispose { actions.setCatalogViewport(workspaceOwner, emptyList()) }
    }
    var refreshRequested by remember { mutableStateOf(false) }
    var createBounds by remember { mutableStateOf<Rect?>(null) }
    var settingsBounds by remember { mutableStateOf<Rect?>(null) }
    LaunchedEffect(state.busy) { if (!state.busy) refreshRequested = false }
    val refresh: () -> Unit = { if (!state.busy) { refreshRequested = true; actions.refresh() } }
    PullToRefreshBox(isRefreshing = refreshRequested && state.busy, onRefresh = refresh, modifier = modifier.fillMaxWidth()) {
        LazyColumn(Modifier.fillMaxSize().testTag("catalog-list").semantics {
            // Pull has a non-gesture equivalent for TalkBack and switch access.
            customActions = listOf(CustomAccessibilityAction("Atualizar conversas") {
                if (state.busy) false else { refresh(); true }
            })
        }, state = list) {
            item(key = "workspace-heading") {
                Row(Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 24.dp), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text("SEU WORKSPACE", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary)
                        Text("Conversas", style = MaterialTheme.typography.displaySmall)
                        Text("i use arch btw", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    IconButton(onClick = { createBounds?.let(origin); onCreate() }, enabled = !state.busy && state.delivery != DeliveryStatus.SENDING,
                        modifier = Modifier.size(48.dp).onGloballyPositioned { createBounds = it.boundsInWindow() }) { CompanionIcon(CompanionGlyph.Add, "Nova conversa") }
                    IconButton(onClick = { settingsBounds?.let(origin); openSettings() }, enabled = accountActionsEnabled,
                        modifier = Modifier.size(48.dp).onGloballyPositioned { settingsBounds = it.boundsInWindow() }) { CompanionIcon(CompanionGlyph.Settings, "Configurações") }
                }
            }
            if (state.chats.isEmpty()) item(key = "empty-catalog") {
                Column(Modifier.padding(24.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text(if (state.busy) "Consultando conversas…" else "Nenhuma conversa carregada", style = MaterialTheme.typography.titleLarge)
                    Text("Puxe para atualizar ou use + para começar.", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            items(state.chats, key = { it.id }) { chat ->
                var bounds by remember(chat.id) { mutableStateOf<Rect?>(null) }
                val cardVisible by remember(list, chat.id) { derivedStateOf {
                    list.layoutInfo.visibleItemsInfo.any { it.key == chat.id }
                } }
                dev.alex.dsh.companion.ui.catalog.ConversationActions(chat,
                    enabled = !state.busy && chat.id !in state.deleteUncertainIds, onDelete = actions::deleteChat,
                    onOpen = { bounds?.let(origin); onOpenChat(chat.id) }, openEnabled = !state.busy,
                    modifier = Modifier.fillMaxWidth().testTag("catalog-row:${chat.id}")
                        .padding(horizontal = 16.dp, vertical = 6.dp).onGloballyPositioned { bounds = it.boundsInWindow() }) {
                    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp), verticalAlignment = Alignment.Top) {
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            Text(chat.title?.takeIf { it.isNotBlank() } ?: "Conversa ${chat.id.takeLast(8)}", style = MaterialTheme.typography.titleMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
                            Text(chat.id.takeLast(8), style = MaterialTheme.typography.labelSmall, fontFamily = FontFamily.Monospace)
                            if (state.deletingId == chat.id) Text("Apagando conversa…", style = MaterialTheme.typography.bodySmall)
                            else chatDate(chat)?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
                            if (chat.id in state.interactionCheckHints && visible && cardVisible && state.appStarted && state.appResumed) {
                                dev.alex.dsh.companion.ui.catalog.InteractionCheckHint(chat.id)
                            }
                        }
                        val activity = state.chatActivity[chat.id]
                        dev.alex.dsh.companion.ui.catalog.ConversationActivityIndicators(chat.id,
                            responding = activity?.knowledge == NativeKnowledge.CURRENT && activity.responding == true,
                            unread = chat.id in state.chatUnread,
                            attention = state.chatAttention[chat.id] ?: dev.alex.dsh.companion.catalog.ConversationAttention(),
                            visible = visible && cardVisible && state.appStarted && state.appResumed,
                            modifier = Modifier.padding(start = 8.dp))
                    }
                }
            }
            if (state.hasMore) item(key = "more-chats") {
                TextButton(onClick = actions::loadMore, enabled = !state.busy, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("Mais conversas") }
            }
        }
    }
}

private fun chatDate(chat: CompanionChat): String? {
    val millis = chat.updatedAt ?: chat.createdAt ?: return null
    return DateTimeFormatter.ofLocalizedDateTime(FormatStyle.SHORT).withLocale(Locale.getDefault()).withZone(ZoneId.systemDefault()).format(Instant.ofEpochMilli(millis))
}

@Composable
private fun ChatScreen(state: CompanionUiState, actions: UiActions,
    presentations: dev.alex.dsh.companion.ui.premium.ConversationPresentationCache, modifier: Modifier = Modifier,
    visible: Boolean = true) {
    val entry = if (state.isNewDraft) remember { dev.alex.dsh.companion.ui.premium.ConversationPresentation() }
        else presentations.access(requireNotNull(state.selectedId))
    val renderState = entry.render
    val entrances = remember(state.selectedId, state.connectionGeneration) { mutableSetOf<String>() }
    val presentation = rememberPacedTranscript(state)
    val rich = presentation.messages
    val folds = renderState.snapshot()
    val plan = rememberTranscriptPlan(state.selectedId, state.connectionGeneration, rich, folds)
    // Hide a closed section immediately, even while its replacement plan is being prepared.
    val transcript = remember(plan.cells, folds) { plan.cells.filter { cell -> cell.requiredFolds.all { folds[it] == true } } }
    val hasRich = state.richMessages.isNotEmpty()
    val hasTranscript = transcript.isNotEmpty() || (!hasRich && (state.messages.isNotEmpty() || state.streamingText != null))
    val placeholderList = rememberLazyListState()
    // Attaching a restored index to a one-row loading placeholder clamps it to zero.
    // Retain only the presentation object; never retain transcript/image content to hide loading.
    val list = if (entry.positioned && !hasTranscript) placeholderList else entry.list
    val tailLayout by remember(list) { derivedStateOf {
        val info = list.layoutInfo
        info.visibleItemsInfo.lastOrNull { it.index == info.totalItemsCount - 1 }?.let { it.key to it.size }
    } }
    val dragged by list.interactionSource.collectIsDraggedAsState()
    var userDragged by remember(entry) { mutableStateOf(false) }
    var following by entry::following
    var positioned by entry::positioned
    val toolbar = LocalTextToolbar.current
    val onInspect = remember(entry) { { entry.following = false } }
    val selectionToolbar = remember(toolbar, entry) { InspectingTextToolbar(toolbar, onInspect) }
    val imageScope = "${state.selectedId}:${state.connectionGeneration}"
    val imageContent: @Composable (ImageReference) -> Unit = remember(actions, imageScope, onInspect) {
        { reference -> OwnedImageCard(reference, actions, imageScope, onInspect = onInspect) }
    }
    val awaitingBlockingUser = state.chatAttention[state.selectedId]?.blocksOnUser == true
    val showResponse = state.connected && state.response.phase != ResponsePhase.IDLE && !awaitingBlockingUser
    val liveHeaderId = rich.lastOrNull { it.streaming && it.role == MessageRole.ASSISTANT }?.stableId
    val liveHeaderItemId = transcript.firstOrNull {
        it.headerEligible && it.role == MessageRole.ASSISTANT && it.sourceStableId == liveHeaderId
    }?.stableId ?: transcript.firstOrNull { it.headerEligible && liveHeaderId != null && liveHeaderId in it.headerSourceIds }?.stableId
    val feedbackItem = showResponse && liveHeaderItemId == null && (rich.isNotEmpty() || state.streamingText == null)
    val lastSeq = rich.lastOrNull()?.seq ?: state.messages.lastOrNull()?.seq
    val approval = state.approvals.firstOrNull { it.key.agentId == state.selectedId }
    val selectedQuestions = state.questions.filter { it.key.agentId == state.selectedId }
    val question = if (approval == null) selectedQuestions.firstOrNull { it.delivery == UserQuestionDelivery.ANSWERABLE }
        ?: selectedQuestions.firstOrNull() else null
    val questionEnabled = visible && state.connected && state.authenticated &&
        (question?.key?.kind != UserQuestionKind.CONTINUED || state.questionProjectionCurrent)
    DisposableEffect(question?.key, questionEnabled, actions) {
        val exactKey = question?.key
        if (exactKey != null && questionEnabled) actions.setQuestionDisplayed(exactKey, true)
        onDispose { if (exactKey != null) actions.setQuestionDisplayed(exactKey, false) }
    }
    val keyboard = LocalSoftwareKeyboardController.current
    LaunchedEffect(approval?.key) { if (approval != null) keyboard?.hide() }
    LaunchedEffect(dragged, list.isScrollInProgress, list.canScrollForward, hasTranscript, state.busy) {
        if (!hasTranscript || state.busy) {
            userDragged = false
        } else if (dragged) {
            following = false
            userDragged = true
        } else if (userDragged && !list.isScrollInProgress) {
            // Only completion of a real content drag may resume tail-following. An initial
            // empty layout reporting canScrollForward=false must not override manual reading.
            if (!list.canScrollForward) following = true
            userDragged = false
        }
    }
    // Formatting/media may finish after native end. Deliberate inspection/selection disables
    // following before those geometry changes, so final layout can still reach its real bottom.
    val liveTailLayout = if (following) tailLayout else null
    var initialTailRequested by remember(state.selectedId, state.connectionGeneration) { mutableStateOf(false) }
    val rowCount = (if (hasRich) transcript.size else state.messages.size + (if (state.streamingText != null) 1 else 0)) +
        (if (state.hasMore) 1 else 0) + (if (feedbackItem) 1 else 0)
    SideEffect {
        if (hasTranscript && following && !positioned && !initialTailRequested && rowCount > 0) {
            // Request before first remeasure: do not measure the history's start just to jump to its tail.
            list.requestScrollToItem(rowCount - 1)
            initialTailRequested = true
        }
    }
    LaunchedEffect(lastSeq, rich.size, state.streamingText?.length, rich.lastOrNull()?.literalText?.length,
        rich.lastOrNull()?.nextIndex, state.response.key, liveTailLayout, following, hasTranscript, plan.frame) {
        if (!hasTranscript || !following || dragged || toolbar.status == TextToolbarStatus.Shown) return@LaunchedEffect
        val count = rowCount
        if (count > 0) {
            withFrameNanos { }
            val last = count - 1
            val streamingGrowth = state.connected && state.response.phase == ResponsePhase.STREAMING
            if (list.layoutInfo.visibleItemsInfo.none { it.index == last }) {
                if (positioned && !streamingGrowth) list.animateScrollToItem(last) else list.scrollToItem(last)
            }
            val item = list.layoutInfo.visibleItemsInfo.lastOrNull { it.index == last }
            val overflow = item?.let { it.offset + it.size - list.layoutInfo.viewportEndOffset + list.layoutInfo.afterContentPadding } ?: 0
            // The final card may be taller than the viewport: follow its BOTTOM, not its top.
            // Token growth must not cancel and restart a220ms tail-chasing tween every delta.
            // Admission still owns its entrance animation; manual reading/selection wins above.
            if (overflow > 0) {
                if (streamingGrowth) list.scrollBy(overflow.toFloat())
                else list.animateScrollBy(overflow.toFloat(), tween(220))
            }
            positioned = true
        }
    }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val receiptCandidate by rememberUpdatedState {
        val layout = list.layoutInfo
        eligibleReadReceipt(state, lifecycle.currentState == Lifecycle.State.RESUMED, visible,
            rich, plan, transcript, ReadReceiptViewport(
                visibleCellBottoms = layout.visibleItemsInfo.associate { it.key.toString() to (it.offset + it.size) },
                start = layout.viewportStartOffset,
                end = layout.viewportEndOffset - layout.afterContentPadding,
                canScrollForward = list.canScrollForward,
                following = following, positioned = positioned,
                dragged = dragged, scrolling = list.isScrollInProgress,
                selecting = toolbar.status == TextToolbarStatus.Shown))
    }
    LaunchedEffect(actions, state.selectedId, state.connectionGeneration, list, lifecycle) {
        snapshotFlow { receiptCandidate() }.collectLatest { receipt ->
            if (receipt == null) return@collectLatest
            // A worker publication is not presentation. Let composition/layout draw before ACK,
            // then recheck the current stamp, pane, lifecycle and geometry (including cadence).
            withFrameNanos { }
            withFrameNanos { }
            if (receiptCandidate() == receipt) actions.acknowledgeVisibleMessage(
                receipt.sessionId, receipt.generation, receipt.transcriptRevision, receipt.sequence)
        }
    }
    Column(modifier.fillMaxWidth()) {
        // Weight belongs to this direct Column child, not a selection wrapper's internal layout.
        Box(Modifier.weight(1f).fillMaxWidth()) {
        CompositionLocalProvider(LocalTextToolbar provides selectionToolbar) {
        SelectionContainer(Modifier.fillMaxSize()) {
        Box(Modifier.fillMaxSize()) {
        LazyColumn(Modifier.fillMaxSize().followTranscriptViewport(list,
            following = following && positioned && hasTranscript,
            blocked = { dragged || toolbar.status == TextToolbarStatus.Shown }), state = list,
            contentPadding = androidx.compose.foundation.layout.PaddingValues(top = 8.dp, bottom = 20.dp),
            verticalArrangement = Arrangement.spacedBy(0.dp)) {
            if (state.hasMore) item(key = "older") {
                TextButton(onClick = { following = false; actions.loadMore() }, enabled = !state.busy, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("Carregar mensagens anteriores") }
            }
            if (hasRich) items(transcript, key = { "$imageScope:${it.stableId}" }, contentType = { it.contentType }) { item ->
                ObserveTranscriptCell("$imageScope:${item.stableId}")
                val header: (@Composable () -> Unit)? = if (showResponse && item.stableId == liveHeaderItemId) {
                    { ResponseFeedback(state, actions, showStop = false) }
                } else null
                val anchor = item.first || item.body is TranscriptCellBody.ActivityHeader || item.body is TranscriptCellBody.ToolHeader
                val admitted = anchor && (item.sourceStableId in presentation.animatedKeys || item.headerSourceIds.any { it in presentation.animatedKeys })
                val appearance = Modifier.animateItem().admittedMessageAppearance(item.stableId, admitted, entrances)
                    .padding(horizontal = 16.dp)
                TranscriptCellContent(item, imageContent, renderState, modifier = appearance,
                    headerContent = header, onInspect = onInspect)
            } else items(state.messages, key = { "message-${it.seq}" }) { message -> MessageCard(message) }
            state.streamingText?.takeIf { !hasRich }?.let { partial ->
                item(key = "streaming") {
                    Column(Modifier.padding(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        if (showResponse) ResponseFeedback(state, actions, showStop = false) else Text(if (state.connected) "Resposta em andamento" else "Resposta parcial · conexão interrompida", style = MaterialTheme.typography.labelMedium)
                        SelectionContainer { Text(partial, style = MaterialTheme.typography.bodyLarge) }
                    }
                }
            }
            if (feedbackItem) item(key = "response-${state.response.key}") {
                ResponseFeedback(state, actions, Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), showStop = false)
            }
            if (hasRich && transcript.isEmpty()) item(key = "preparing") {
                Text("Preparando conversa…", modifier = Modifier.padding(24.dp), style = MaterialTheme.typography.bodyLarge)
            }
            if (!hasRich && state.messages.isEmpty() && state.streamingText == null && !showResponse && state.isNewDraft) item(key = "blank") {
                Text("Envie uma mensagem para começar.", modifier = Modifier.padding(24.dp), style = MaterialTheme.typography.bodyLarge)
            }
        }
        if (!showResponse && hasTranscript && (state.presentationPending || plan.pending)) {
            DisableSelection {
                Text("Formatando conteúdo", Modifier.align(Alignment.BottomEnd).padding(12.dp),
                    style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        if (!state.isNewDraft && !hasTranscript && (state.busy || state.presentationPending || !state.connected)) {
            MockFrameStage(Modifier.fillMaxSize(), active = visible)
        }
        }
        }
        }
        }
        if ((state.chatAttention[state.selectedId]?.unsupported ?: 0) > 0) UnsupportedRequestNotice()
        if (approval != null) key(approval.key) { ApprovalCard(approval, visible && state.connected && state.authenticated, actions) }
        if (question != null) key(question.key) {
            UserQuestionCard(question, questionEnabled, actions::answerQuestion)
        }
        Composer(state, actions)
    }
}

@Composable
private fun MessageCard(message: UiMessage) {
    val human = message.role == MessageRole.USER
    val content: @Composable () -> Unit = {
        Column(Modifier.padding(if (human) 16.dp else 0.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            if (message.role == MessageRole.TOOL || message.role == MessageRole.NOTICE)
                Text(if (message.role == MessageRole.TOOL) "Ferramenta" else "Aviso", style = MaterialTheme.typography.labelSmall)
            // The legacy fallback keeps exact selectable source, not a second Markdown engine.
            SelectionContainer {
                Text(message.text, style = MaterialTheme.typography.bodyLarge, fontFamily = if (message.role == MessageRole.TOOL || message.text.contains("```")) FontFamily.Monospace else FontFamily.Default)
            }
        }
    }
    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 3.dp), horizontalArrangement = Arrangement.End) {
        if (human) Surface(Modifier.fillMaxWidth(.88f), color = MaterialTheme.colorScheme.surfaceContainerHigh,
            shape = MaterialTheme.shapes.large, content = content)
        else Column(Modifier.fillMaxWidth()) { content() }
    }
}

/** Never a response control: the request could not be decoded or exceeds a limit of this app. */
@Composable
private fun UnsupportedRequestNotice() {
    Card(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp).testTag("unsupported-request")) {
        Text("Há um pedido de permissão ou pergunta que este app não consegue exibir com segurança. Responda pelo PC.",
            modifier = Modifier.padding(12.dp), style = MaterialTheme.typography.bodyMedium)
    }
}

@Composable
private fun ApprovalCard(presentation: ApprovalPresentation, connected: Boolean, actions: UiActions) {
    var decisionSent by remember(presentation.key) { mutableStateOf(false) }
    val readable = !presentation.reason.isNullOrBlank() || presentation.displayReason?.values?.any { it.isNotBlank() } == true
    Card(Modifier.fillMaxWidth().padding(12.dp)) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Confirmação necessária", style = MaterialTheme.typography.titleMedium)
            SelectionContainer {
                Column(Modifier.fillMaxWidth().heightIn(max = 180.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(presentation.toolName, fontFamily = FontFamily.Monospace)
                    presentation.callId?.let { Text(it, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall) }
                    presentation.reason?.let { Text(it) }
                    presentation.displayReason?.forEach { (locale, literal) ->
                        Text(locale, style = MaterialTheme.typography.labelSmall)
                        Text(literal)
                    }
                    if (!readable) Text("O servidor não informou uma descrição legível. Não é possível autorizar esta ação.")
                }
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = { decisionSent = true; actions.decide(presentation.key, ApprovalDecision.REJECT) }, enabled = connected && !decisionSent, modifier = Modifier.weight(1f).heightIn(min = 48.dp)) { Text("Rejeitar") }
                Button(onClick = { decisionSent = true; actions.decide(presentation.key, ApprovalDecision.ALLOW_ONCE) }, enabled = connected && readable && !decisionSent, modifier = Modifier.weight(1f).heightIn(min = 48.dp)) { Text("Permitir uma vez") }
            }
        }
    }
}

@Composable
private fun Composer(state: CompanionUiState, actions: UiActions) {
    val sending = state.delivery == DeliveryStatus.SENDING
    val unknown = state.delivery == DeliveryStatus.UNKNOWN
    var goalsExpanded by remember(state.selectedId) { mutableStateOf(false) }
    val nativeGoals = state.nativeGoals.takeIf { it.sessionId == state.selectedId } ?: NativeGoalsState()
    val goalListHeight = (LocalConfiguration.current.screenHeightDp.dp * .22f).coerceAtMost(180.dp)
    LaunchedEffect(goalsExpanded, state.selectedId, state.connectionGeneration, state.connected) {
        if (goalsExpanded && state.authenticated && state.connected) actions.refreshNativeGoals()
    }
    var stopRequested by remember(state.selectedId, state.connectionGeneration, state.response.key, state.fileSendPhase) { mutableStateOf(false) }
    var retiredStopHitArea by remember(state.selectedId, state.connectionGeneration) { mutableStateOf(false) }
    val doubleTapTimeout = LocalViewConfiguration.current.doubleTapTimeoutMillis
    LaunchedEffect(retiredStopHitArea) {
        if (retiredStopHitArea) {
            kotlinx.coroutines.delay(doubleTapTimeout)
            retiredStopHitArea = false
        }
    }
    val stopVisible = state.canStopResponse && !stopRequested
    val lineHeight = with(LocalDensity.current) { MaterialTheme.typography.bodyLarge.lineHeight.toDp() }
    // A withdrawn stop must not uncover the editor (or a new response's stop) under the second tap.
    val keepStopSlot = stopVisible || stopRequested || retiredStopHitArea
    val actionsWidth = if (keepStopSlot) 96.dp else 48.dp
    Column(Modifier.fillMaxWidth().workspaceGestureExcluded().padding(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        when (state.delivery) {
            DeliveryStatus.NONE -> Unit
            DeliveryStatus.SENDING -> Text(when (state.fileSendPhase) {
                FileSendPhase.PREPARING -> "Preparando conversa…"
                FileSendPhase.UPLOADING -> "Enviando arquivos…"
                FileSendPhase.AWAITING_PROMPT -> "Aguardando confirmação da mensagem…"
                FileSendPhase.NONE -> "Enviando…"
            }, style = MaterialTheme.typography.bodySmall)
            DeliveryStatus.ADMITTED -> Unit
            DeliveryStatus.UNKNOWN -> Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text(when {
                    state.isNewDraft -> "Criação sem confirmação. Pode ter ficado uma conversa vazia na lista; Reenviar cria outra."
                    state.resendFiles > 0 -> "Envio sem confirmação. Selecione os mesmos arquivos e toque em Reenviar; o mesmo identificador não duplica a mensagem."
                    else -> "Envio sem confirmação. Reenviar usa o mesmo identificador e não duplica uma mensagem já recebida."
                }, modifier = Modifier.weight(1f), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
                TextButton(onClick = actions::resendUncertain, enabled = state.canResendUncertain,
                    modifier = Modifier.heightIn(min = 48.dp).testTag("resend-uncertain")) { Text("Reenviar") }
            }
        }
        if (state.filePickerPending) Text("Conferindo seleção de arquivos…", style = MaterialTheme.typography.bodySmall)
        dev.alex.dsh.companion.ui.files.SelectedFileRow(state.selectedFiles, actions::removeFile)
        // An uncertain file prompt can only be resent with a fresh selection of its files.
        val reselectForResend = unknown && state.resendFiles > 0
        if (state.selectedFiles.any { it.needsReselect } || reselectForResend && state.selectedFiles.size < state.resendFiles) TextButton(onClick = actions::attachFiles,
            enabled = state.authenticated && !sending && (!unknown || reselectForResend) && !state.filePickerPending) { Text("Selecionar arquivos novamente") }
        Surface(color = MaterialTheme.colorScheme.surfaceContainerHigh, shape = RoundedCornerShape(28.dp),
            modifier = Modifier.fillMaxWidth().testTag("message-composer")) {
            Column {
                AnimatedVisibility(visible = goalsExpanded && !state.isNewDraft,
                    enter = expandVertically(tween(240)) + fadeIn(tween(160)),
                    exit = shrinkVertically(tween(180)) + fadeOut(tween(120))) {
                    dev.alex.dsh.companion.ui.goals.GoalPanel(nativeGoals, state.authenticated && state.connected,
                        actions::refreshNativeGoals, actions::controlNativeGoal, goalListHeight)
                }
            Box(Modifier.fillMaxWidth()) {
                BasicTextField(value = state.draft, onValueChange = actions::draft, enabled = !sending,
                    minLines = 1, maxLines = Int.MAX_VALUE,
                    textStyle = MaterialTheme.typography.bodyLarge.copy(color = MaterialTheme.colorScheme.onSurface),
                    cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
                    // Reuse the former 56dp action row as editable viewport, within the same outer height budget.
                    // A side gutter protects caret/selection from both 48dp buttons without hiding literal draft text.
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 18.dp, vertical = 12.dp)
                        .padding(end = actionsWidth + 8.dp)
                        .heightIn(min = lineHeight + 56.dp, max = lineHeight * 4 + 56.dp).testTag("message-input")
                        .semantics { contentDescription = "Mensagem" },
                    decorationBox = { field ->
                        Box {
                            if (state.draft.isEmpty()) Text("Mensagem", style = MaterialTheme.typography.bodyLarge,
                                color = MaterialTheme.colorScheme.onSurfaceVariant)
                            field()
                        }
                    })
                // The 14dp mark sits above Send inside its existing end gutter;
                // its independent 48dp target does not take any editor height.
                if (!state.isNewDraft) IconButton(onClick = { goalsExpanded = !goalsExpanded },
                    modifier = Modifier.align(Alignment.TopEnd).padding(end = 8.dp).size(48.dp).testTag("toggle-native-goals")) {
                    CompanionIcon(CompanionGlyph.Goal,
                        if (goalsExpanded) "Recolher goals e TODO" else "Mostrar goals e TODO", Modifier.size(14.dp))
                }
                Row(Modifier.align(Alignment.BottomEnd).padding(end = 8.dp, bottom = 8.dp), horizontalArrangement = Arrangement.End) {
                    // Stopping must not replace the existing ability to enqueue another literal prompt.
                    if (stopVisible) IconButton(onClick = {
                        if (state.canStopResponse && !stopRequested && !retiredStopHitArea) {
                            stopRequested = true
                            retiredStopHitArea = true
                            actions.cancelTurn()
                        }
                    }, enabled = !retiredStopHitArea, modifier = Modifier.size(48.dp)) { CompanionIcon(CompanionGlyph.Stop, "Parar resposta") }
                    else if (keepStopSlot) Box(Modifier.size(48.dp))
                    dev.alex.dsh.companion.ui.files.ComposerFileAction(
                        text = state.draft, readyFileCount = state.selectedFiles.count { !it.needsReselect },
                        canAttach = state.authenticated && !state.busy && !sending && (!unknown || reselectForResend) && !state.filePickerPending,
                        canSend = state.authenticated && (state.connected || state.isNewDraft) && !state.busy && !sending && !unknown &&
                            !state.filePickerPending && state.selectedFiles.none { it.needsReselect } && (state.draft.isNotBlank() || state.selectedFiles.isNotEmpty()),
                        onAttach = actions::attachFiles, onSend = actions::send)
                }
            }
            }
        }
    }
}
