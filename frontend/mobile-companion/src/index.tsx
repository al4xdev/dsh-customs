import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type JSX } from 'react';
import type { CompanionChat } from './api';
import { attachMessageMotion } from './motion/messages';
import { attachNavigationMotion, type NavigationMotionController } from './motion/navigation';
import type { NavigationDirection } from './motion/physics';
import type { BodyProps, RootContext, RootProps, SessionRef } from './types/dsh';

export const name = 'mobile-companion';
export const inject = ['slots', 'sessions', 'uiSession', 'uiConversation', 'mobileCompanion', 'connection'];
const CONTENT_SLOTS = { widthControls: (): null => null };

function ConversationBody({ useSession, renderFactorySlot }: BodyProps): JSX.Element {
  const openState = useSession(session => session.openState);
  // Native hero exposes a workspace/preset chooser and makes ungrouped blank chats inert.
  // A selected companion is already a valid target: use the regular composer even when blank.
  return <div className="mobile-conversation" data-phase={openState === 'loading' ? 'settling' : 'active'}>
    {renderFactorySlot('conversation.content', {
      variant: 'embedded', phase: openState === 'loading' ? 'settling' : 'active', hero: false,
    }, { slots: CONTENT_SLOTS })}
  </div>;
}

function chatTitle(chat?: Pick<CompanionChat, 'id' | 'title'>): string {
  if (chat === undefined) return 'Conversa';
  return chat.title.trim().length === 0 || chat.title === 'Conversa' ? `Conversa · ${chat.id.slice(-8)}` : chat.title;
}

function formatDate(value?: string | number): string {
  if (value === undefined) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat('pt-BR', { day: 'numeric', month: 'short' }).format(date);
}

/** Cancellation is mutable across await boundaries; always read its current value. */
function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

/** Only this root owns the mainView reference; neither URLs nor uiWorkspace may open history directly. */
function mobileRoot(ctx: RootContext): (props: RootProps) => JSX.Element {
  const mobile = ctx.mobileCompanion;
  return function MobileRoot({ SessionProvider, renderSlot }: RootProps): JSX.Element {
    // Native sources expose methods, so preserve their receiver instead of extracting them.
    const subscribeMobile = useCallback((listener: () => void) => mobile.state.subscribe(listener), []);
    const getMobileSnapshot = useCallback(() => mobile.state.getSnapshot(), []);
    const connectionSource = ctx.connection.state;
    const subscribeConnection = useCallback((listener: () => void) => connectionSource.subscribe(listener), [connectionSource]);
    const getConnectionSnapshot = useCallback(() => connectionSource.getSnapshot(), [connectionSource]);
    const state = useSyncExternalStore(subscribeMobile, getMobileSnapshot, getMobileSnapshot);
    const connection = useSyncExternalStore(subscribeConnection, getConnectionSnapshot, getConnectionSnapshot);
    const [selection, setSelection] = useState<{ reference: SessionRef; revision: number }>();
    const selectedSessionReference = selection?.reference;
    const [opening, setOpening] = useState(false);
    const [openError, setOpenError] = useState<string>();
    const root = useRef<HTMLElement>(null);
    const navigationMotion = useRef<NavigationMotionController>();
    const lastChat = useRef<string>();
    const direction = useRef<NavigationDirection>('forward');
    const enteredRoute = useRef<string>();

    useEffect(() => {
      const element = root.current;
      if (element === null) return;
      const controller = attachNavigationMotion({
        root: element,
        getSelectedId: () => mobile.state.getSnapshot().selectedId,
        back: () => { direction.current = 'back'; mobile.back(); },
        forward: async () => {
          const id = lastChat.current;
          if (id !== undefined) { direction.current = 'forward'; await mobile.select(id); }
        },
        canForward: () => mobile.state.getSnapshot().selectedId === undefined && lastChat.current !== undefined,
      });
      navigationMotion.current = controller;
      return () => { controller.dispose(); navigationMotion.current = undefined; };
    }, []);

    useEffect(() => {
      const disposeNavigation = mobile.attachNavigation(window);
      void mobile.refresh();
      const reset = ctx.on('connection/reset', () => {
        void mobile.refresh();
        const id = mobile.state.getSnapshot().selectedId;
        if (id !== undefined) void mobile.select(id);
      });
      const online = (): void => { ctx.connection.reconnect(); void mobile.refresh(); };
      window.addEventListener('online', online);
      const viewport = window.visualViewport;
      const resize = (): void => {
        root.current?.style.setProperty('--mobile-viewport-height', `${String(viewport?.height ?? window.innerHeight)}px`);
      };
      resize();
      viewport?.addEventListener('resize', resize);
      window.addEventListener('resize', resize);
      return () => {
        disposeNavigation(); reset(); window.removeEventListener('online', online);
        viewport?.removeEventListener('resize', resize); window.removeEventListener('resize', resize);
      };
    }, []);

    useEffect(() => {
      const id = state.selectedId;
      const abort = new AbortController();
      let owned: SessionRef | undefined;
      const release = (): void => {
        const reference = owned;
        owned = undefined;
        reference?.release();
      };
      setSelection(undefined);
      setOpenError(undefined);
      setOpening(id !== undefined);
      if (id !== undefined) {
        const open = async (): Promise<void> => {
          try {
            const allowed = await mobile.api.assertAllowed(id, abort.signal);
            if (isAborted(abort.signal)) return;
            await ctx.sessions.refresh();
            if (isAborted(abort.signal)) return;
            const reference = ctx.sessions.retain(allowed.id, { source: 'mainView', signal: abort.signal });
            owned = reference;
            await reference.ready;
            if (isAborted(abort.signal)) return;
            setSelection({ reference, revision: state.revision });
            setOpening(false);
          } catch (error) {
            release();
            if (!isAborted(abort.signal)) {
              setOpening(false);
              const message = error instanceof Error ? error.message : 'Não foi possível abrir a conversa.';
              setOpenError(message);
              // A second header guard can fail after route admission. Never leave
              // a now-invalid address selected, including races during reconnect.
              mobile.rejectSelection(id, state.revision, message);
            }
          }
        };
        void open();
      }
      return () => { abort.abort(); release(); };
    }, [state.selectedId, state.revision]);

    const visibleReference = selection?.revision === state.revision && selectedSessionReference?.sessionId === state.selectedId
      ? selectedSessionReference : undefined;
    useEffect(() => {
      const route = visibleReference?.sessionId ?? (state.selectedId === undefined ? 'list' : undefined);
      if (route === undefined || route === enteredRoute.current) return;
      if (visibleReference !== undefined) lastChat.current = visibleReference.sessionId;
      if (enteredRoute.current !== undefined) navigationMotion.current?.enter(state.selectedId === undefined ? 'back' : direction.current);
      enteredRoute.current = route;
    }, [state.selectedId, visibleReference]);

    useEffect(() => {
      const element = root.current?.querySelector<HTMLElement>('.mobile-chat');
      if (element === null || element === undefined || visibleReference === undefined) return;
      const controller = attachMessageMotion(element, { getSessionKey: () => visibleReference.sessionId });
      return () => { controller.dispose(); };
    }, [visibleReference]);

    const selected = state.chats.find(chat => chat.id === state.selectedId);
    const disconnected = connection !== 'connected';
    const focusComposer = (): void => {
      root.current?.querySelector<HTMLElement>('[data-composer-input][contenteditable="true"]')?.focus({ preventScroll: true });
    };
    const create = (): void => {
      void mobile.create().catch(() => {
        // create() already publishes its failure to the mobile error notice.
      });
    };
    const reopen = (): void => {
      const id = state.selectedId;
      if (id !== undefined) void mobile.select(id);
    };
    const back = (): void => {
      direction.current = 'back';
      const controller = navigationMotion.current;
      if (controller === undefined) mobile.back();
      else void controller.navigate('back', () => { mobile.back(); });
    };
    const select = (id: string): void => {
      direction.current = 'forward';
      const controller = navigationMotion.current;
      if (controller === undefined) void mobile.select(id);
      else void controller.navigate('forward', () => mobile.select(id));
    };
    const reconnect = (): void => { ctx.connection.reconnect(); };
    const refresh = (): void => { void mobile.refresh(); };
    return <main ref={root} className="mobile-companion" aria-label="Companion" lang="pt-BR">
      <header className="mobile-header">
        {state.selectedId !== undefined && <button type="button" className="mobile-icon-button" onClick={back} aria-label="Voltar para conversas"><span aria-hidden="true">←</span></button>}
        <div className="mobile-heading"><span className="mobile-eyebrow">Companion</span>
          <h1>{state.selectedId !== undefined ? chatTitle(selected) : 'Conversas'}</h1>
        </div>
        <button type="button" className="mobile-new" onClick={create} disabled={state.creating || disconnected}>
          <span aria-hidden="true">＋</span><span>{state.creating ? 'Criando…' : 'Nova'}</span>
        </button>
      </header>
      <div className="mobile-connection" role="status" aria-live="polite" data-connected={!disconnected}>
        <span className="mobile-connection-dot" aria-hidden="true" />
        <span>{connection === 'connected' ? 'Conectado' : connection === 'disconnected' ? 'Sem conexão' : 'Conectando…'}</span>
        {disconnected && <button type="button" onClick={reconnect}>Reconectar</button>}
        {!disconnected && visibleReference !== undefined && <button type="button" onClick={focusComposer}>Escrever</button>}
      </div>
      {state.error !== undefined && <div className="mobile-notice" role="alert"><p>{state.error}</p>
        <button type="button" onClick={refresh}>Tentar novamente</button></div>}
      {state.selectedId !== undefined ? <section className="mobile-chat" aria-label="Conversa">
        {opening && <div className="mobile-empty" role="status"><p>Carregando conversa…</p></div>}
        {openError !== undefined && <div className="mobile-empty" role="alert"><h2>Conversa indisponível</h2><p>{openError}</p>
          <button className="mobile-action" type="button" onClick={reopen}>Tentar novamente</button>
          <button className="mobile-action" type="button" onClick={back}>Voltar para conversas</button></div>}
        {visibleReference !== undefined && <SessionProvider session={visibleReference} empty={() => <div className="mobile-empty" role="status">
          <p>Reconectando conversa…</p><button className="mobile-action" type="button" onClick={reopen}>Reabrir conversa</button>
        </div>}>{renderSlot('mobile.conversation', {})}</SessionProvider>}
      </section> : <section className="mobile-list" aria-label="Conversas do Companion" aria-busy={state.loading}>
        <div className="mobile-list-caption"><p>Suas conversas</p><button type="button" onClick={refresh} disabled={state.loading}>
          {state.loading ? 'Atualizando…' : 'Atualizar'}</button></div>
        {state.chats.length === 0 && <div className="mobile-empty" role="status">
          <h2>{state.loading ? 'Carregando conversas…' : 'Vamos conversar?'}</h2>
          {!state.loading && <><p>Abra uma conversa com o Companion. Outros projetos ficam na ferramenta session, dentro do chat.</p>
            <button className="mobile-action" type="button" onClick={create} disabled={state.creating || disconnected}>Nova conversa</button></>}
        </div>}
        <ul>{state.chats.map(chat => <li key={chat.id}><button type="button" className="mobile-chat-row" aria-label={`Abrir ${chatTitle(chat)}, identificador ${chat.id}`} onClick={() => { select(chat.id); }}>
          <span className="mobile-chat-mark" aria-hidden="true">↗</span><span className="mobile-chat-title">{chatTitle(chat)}</span>
          <time className="mobile-chat-date">{formatDate(chat.updatedAt)}</time><span aria-hidden="true">›</span>
        </button></li>)}</ul>
      </section>}
    </main>;
  };
}

export function apply(ctx: RootContext): void {
  ctx.effect(() => {
    const disposeRoot = ctx.slots.register({ name: 'root', priority: -100,
      children: { 'mobile.conversation': { kind: 'single', scope: 'session-maybe' } },
    }, mobileRoot(ctx));
    const disposeBody = ctx.slots.register({ name: 'mobile.conversation' }, ConversationBody);
    return () => { disposeBody(); disposeRoot(); };
  });
}
export default { name, inject, apply };
