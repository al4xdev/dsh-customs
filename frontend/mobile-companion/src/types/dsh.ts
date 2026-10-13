import type { ISessions, SessionReference } from '@deepseek-ai/dsh-api-session-controller/client';
import type { IWorkspaces } from '@deepseek-ai/dsh-api-workspace-controller/client';
import type { ConnectionHandle, ConnectionState } from '@deepseek-ai/dsh-client-connection/client';
import type { ObservableSnapshot, SnapshotStore } from '@deepseek-ai/dsh-client-store';
import type { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client';
import type { PropsRenderFactories, PropsRenderSlots, SessionMaybeStandardProps } from '@deepseek-ai/dsh-client-ui-slots';
import type { UiWorkspace } from '@deepseek-ai/dsh-client-ui-workspace/client';
import type { ConversationContentInputProps } from '@deepseek-ai/dsh-client-ui-conversation/client';
import type { UseSession } from '@deepseek-ai/dsh-client-ui-session/client';
import type { MobileCompanion } from '../workspace';

export type Dispose = () => void;
export type SessionRef = SessionReference;
export type NativeConnectionState = ConnectionState;
export type NativeSnapshot<T> = ObservableSnapshot<T>;
export type NativeSnapshotStore<T> = SnapshotStore<T>;
export type NativeUseSession = UseSession;
export type NativeConversationInput = ConversationContentInputProps;

/** Only the owned child slot is added; native factory/session contracts stay upstream-owned. */
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'mobile.conversation': { kind: 'single'; scope: 'session-maybe' };
  }
}

export type RootProps = PropsRenderSlots<'mobile.conversation'>;
export type BodyProps = Pick<SessionMaybeStandardProps, 'useSession'> & PropsRenderFactories;

export interface ProvidedServices {
  mobileCompanion: MobileCompanion;
  uiWorkspace: UiWorkspace;
}

/** Narrow capability boundary: it does not inherit Cordis's open service index signature. */
export interface RuntimeContext {
  readonly mobileCompanion: MobileCompanion;
  readonly sessions: Pick<ISessions, 'refresh' | 'retain'>;
  readonly connection: Pick<ConnectionHandle, 'state' | 'reconnect'>;
  readonly workspaces: Pick<IWorkspaces, 'list'>;
  readonly slots: Pick<SlotRegistry, 'register' | 'provideRoot'>;
  readonly reflect: {
    provide<K extends keyof ProvidedServices>(name: K, value: ProvidedServices[K]): Dispose;
  };
  on(event: 'connection/reset', listener: () => void): Dispose;
  effect(setup: () => Dispose): void;
}

export type RootContext = Pick<RuntimeContext, 'mobileCompanion' | 'sessions' | 'connection' | 'slots' | 'on' | 'effect'>;
export type WorkspaceContext = Pick<RuntimeContext, 'workspaces' | 'slots' | 'reflect' | 'effect'>;
