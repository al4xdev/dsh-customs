import { createSnapshotStore } from '@deepseek-ai/dsh-client-store';
import type { UiWorkspace } from '@deepseek-ai/dsh-client-ui-workspace/client';
import { CompanionApi, MobileApiError, type CompanionChat } from './api';
import type { Dispose, WorkspaceContext } from './types/dsh';

export interface MobileState {
  chats: CompanionChat[];
  selectedId: string | undefined;
  revision: number;
  loading: boolean;
  creating: boolean;
  error: string | undefined;
}
type NavigationMode = 'push' | 'restore';
const ROUTE_KEY = 'mobileCompanionRoute';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class MobileCompanion {
  readonly state = createSnapshotStore<MobileState>({
    chats: [], selectedId: undefined, revision: 0, loading: true, creating: false, error: undefined,
  });
  private active = true;
  private refreshSerial = 0;
  private navigationSerial = 0;
  private navigationAbort: AbortController | undefined;
  private browser: Window | undefined;
  constructor(readonly api = new CompanionApi()) {}

  update(patch: Partial<MobileState>): void {
    if (this.active) this.state.set({ ...this.state.getSnapshot(), ...patch });
  }

  private distance(): number {
    const history: unknown = this.browser?.history.state;
    const route = isRecord(history) ? history[ROUTE_KEY] : undefined;
    const value = isRecord(route) ? route['distance'] : undefined;
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value < 1000 ? value : 0;
  }

  private writeRoute(id: string | undefined, replace: boolean, distance: number): void {
    if (this.browser === undefined) return;
    const url = new URL(this.browser.location.href);
    if (id !== undefined && id.length > 0) url.searchParams.set('chat', id);
    else url.searchParams.delete('chat');
    // Browser history is an untrusted structured-clone value, not a typed record.
    const previous: unknown = this.browser.history.state;
    const state = { ...(isRecord(previous) ? previous : {}), [ROUTE_KEY]: { distance } };
    this.browser.history[replace ? 'replaceState' : 'pushState'](state, '', url);
  }

  private clearSelection(error?: string): void {
    ++this.navigationSerial;
    this.navigationAbort?.abort();
    this.update({ selectedId: undefined, revision: this.state.getSnapshot().revision + 1, error });
  }

  /** History stores only proven companion ids, never tokens or native saved selection. */
  attachNavigation(browser: Window): Dispose {
    this.browser = browser;
    const restore = (): void => {
      this.clearSelection();
      const requested = new URL(browser.location.href).searchParams.get('chat');
      if (requested !== null && requested.length > 0) void this.select(requested, 'restore');
      else this.writeRoute(undefined, true, 0);
    };
    browser.addEventListener('popstate', restore);
    restore();
    return () => {
      browser.removeEventListener('popstate', restore);
      this.navigationAbort?.abort();
      ++this.navigationSerial;
      if (this.browser === browser) this.browser = undefined;
    };
  }

  async refresh(): Promise<void> {
    const serial = ++this.refreshSerial;
    this.update({ loading: true, error: undefined });
    try {
      const chats = await this.api.list();
      const selectedState = this.state.getSnapshot();
      const selectedId = selectedState.selectedId;
      // Absence from the newest page is not revocation; use the header guard.
      if (selectedId !== undefined && !chats.some(chat => chat.id === selectedId)) {
        try { chats.push(await this.api.assertAllowed(selectedId)); }
        catch (error) {
          if (error instanceof MobileApiError && error.status !== undefined && [401, 403, 404].includes(error.status)) {
            this.rejectSelection(selectedId, selectedState.revision, 'Esta conversa não está disponível no Companion.');
          }
          throw error;
        }
      }
      if (serial === this.refreshSerial) this.update({ chats, loading: false });
    } catch (error) {
      if (serial === this.refreshSerial) this.update({ loading: false, error: error instanceof Error ? error.message : 'Não foi possível carregar as conversas.' });
    }
  }

  /** Re-read mutable lifetime/cancellation state after each asynchronous boundary. */
  private navigationIsCurrent(serial: number, signal: AbortSignal): boolean {
    return this.active && !signal.aborted && serial === this.navigationSerial;
  }

  async select(id: string, mode: NavigationMode = 'push'): Promise<void> {
    if (!this.active) return;
    const serial = ++this.navigationSerial;
    this.navigationAbort?.abort();
    const abort = this.navigationAbort = new AbortController();
    try {
      const chat = await this.api.assertAllowed(id, abort.signal);
      if (!this.navigationIsCurrent(serial, abort.signal)) return;
      const current = this.state.getSnapshot();
      if (mode === 'push' && current.selectedId !== id) {
        // An initial deep link has no in-app list ancestor. Its explicit Back
        // replaces the route instead of accidentally leaving the application.
        if (current.selectedId === undefined || this.distance() === 0) this.writeRoute(undefined, true, 0);
        this.writeRoute(id, false, this.distance() + 1);
      } else this.writeRoute(id, true, this.distance());
      this.update({ selectedId: id, revision: current.revision + 1, error: undefined,
        chats: current.chats.some(row => row.id === id) ? current.chats.map(row => row.id === id ? chat : row) : [chat, ...current.chats] });
    } catch (error) {
      if (!this.navigationIsCurrent(serial, abort.signal)) return;
      const message = error instanceof Error ? error.message : 'Não foi possível abrir a conversa.';
      if (mode === 'restore') {
        this.writeRoute(undefined, true, 0);
        this.clearSelection(message);
      } else this.update({ error: message });
    }
  }

  rejectSelection(id: string, revision: number, message: string): void {
    const current = this.state.getSnapshot();
    if (current.selectedId !== id || current.revision !== revision) return;
    this.writeRoute(undefined, true, 0);
    this.clearSelection(message);
  }

  back(): void {
    const distance = this.distance();
    this.clearSelection();
    if (this.browser !== undefined && distance > 0) this.browser.history.go(-distance);
    else this.writeRoute(undefined, true, 0);
  }

  async create(): Promise<string> {
    if (this.state.getSnapshot().creating) throw new Error('Uma conversa já está sendo criada.');
    const navigation = this.navigationSerial;
    this.update({ creating: true, error: undefined });
    try {
      const id = await this.api.create();
      await this.refresh();
      // Creating is not abortable after admission. A later Back/navigation wins;
      // the new chat still appears in the list without stealing the current route.
      if (navigation === this.navigationSerial) await this.select(id);
      return id;
    } catch (error) {
      this.update({ error: error instanceof Error ? error.message : 'Não foi possível criar a conversa.' });
      throw error;
    } finally { this.update({ creating: false }); }
  }

  dispose(): void {
    this.active = false;
    ++this.refreshSerial;
    ++this.navigationSerial;
    this.navigationAbort?.abort();
  }
}

export const name = 'mobile-companion-workspace';
export const inject = ['slots', 'workspaces'];

/** Replaces, never calls, upstream ui-workspace apply: no restoreSelection or default workspace creation. */
export function apply(ctx: WorkspaceContext): void {
  const mobile = new MobileCompanion();
  const unavailable = (): Error => new Error('Use a ferramenta session dentro da conversa para acessar outros projetos.');
  const denied = (): Promise<never> => Promise.reject(unavailable());
  const workspace: UiWorkspace = {
    openSession(target): void {
      if (typeof target !== 'string') throw unavailable();
      void mobile.select(target);
    },
    startSession(workspaceId): void {
      if (workspaceId !== undefined) throw unavailable();
      void mobile.create().catch(() => {
        // create() already publishes its failure to the mobile error notice.
      });
    },
    connectWorkspace: denied,
    openWorkspace: denied,
    forkSession: denied,
    archiveSession: denied,
    unarchiveSession: denied,
    pinSession: denied,
    unpinSession: denied,
    pickDirectory: (): Promise<string | null> => Promise.resolve(null),
    listDirectory: denied,
    createDirectory: denied,
  };
  ctx.effect(() => {
    const disposeWorkspace = ctx.reflect.provide('uiWorkspace', workspace);
    const disposeMobile = ctx.reflect.provide('mobileCompanion', mobile);
    const disposeHooks = ctx.slots.provideRoot({ hooks: { workspaces: ctx.workspaces.list } });
    return () => { disposeHooks(); disposeMobile(); disposeWorkspace(); mobile.dispose(); };
  });
}
export default { name, inject, apply };
