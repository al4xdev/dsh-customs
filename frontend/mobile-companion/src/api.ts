import type { SessionId } from '@deepseek-ai/dsh-session/types';

export interface CompanionChat {
  id: SessionId;
  title: string;
  createdAt?: string | number;
  updatedAt?: string | number;
}
export type FetchCaller = (input: string, init?: RequestInit) => Promise<Response>;

export class MobileApiError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Admit the native compile-time identity brand only at the validated wire boundary. */
function isSessionId(value: unknown): value is SessionId {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value);
}
function timestamp(value: unknown): string | number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.length <= 64) return value;
  return undefined;
}
function chat(value: unknown): CompanionChat {
  if (!isRecord(value) || !isSessionId(value['id'])) {
    throw new MobileApiError('A lista de conversas retornou dados inválidos.');
  }
  // Display projections can be absent; membership relies on server header proof.
  const createdAt = timestamp(value['createdAt']);
  const updatedAt = timestamp(value['updatedAt']) ?? createdAt;
  return {
    id: value['id'],
    title: typeof value['title'] === 'string' ? value['title'].slice(0, 512) : 'Conversa',
    ...(createdAt === undefined ? {} : { createdAt }),
    ...(updatedAt === undefined ? {} : { updatedAt }),
  };
}

/** No bearer persistence or configurable origin: the server owns preset enforcement. */
export class CompanionApi {
  private readonly caller: FetchCaller;
  constructor(caller: FetchCaller = (url, init) => fetch(url, init)) {
    this.caller = caller;
  }
  private async request(path: string, method: 'GET' | 'POST' = 'GET', signal?: AbortSignal): Promise<unknown> {
    const response = await this.caller(`/mobile-api/chats${path}`, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      ...(signal === undefined ? {} : { signal }),
      headers: { Accept: 'application/json', ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) },
      ...(method === 'POST' ? { body: '{}' } : {}),
    });
    if (!response.ok) {
      throw new MobileApiError(response.status === 401 || response.status === 403
        ? 'Acesso não autorizado. Entre novamente para continuar.'
        : response.status === 404 ? 'Esta conversa não está disponível no Companion.'
        : 'Não foi possível acessar as conversas. Tente novamente.', response.status);
    }
    const payload: unknown = await response.json();
    return payload;
  }
  async list(signal?: AbortSignal): Promise<CompanionChat[]> {
    const data = await this.request('?limit=100', 'GET', signal);
    if (!isRecord(data) || data['profile'] !== 'companion' || !Array.isArray(data['chats'])) {
      throw new MobileApiError('Não foi possível validar o perfil Companion.');
    }
    const values: readonly unknown[] = data['chats'];
    const rows = values.map(chat);
    if (new Set(rows.map(row => row.id)).size !== rows.length) {
      throw new MobileApiError('A lista de conversas retornou dados inválidos.');
    }
    return rows;
  }
  async assertAllowed(id: string, signal?: AbortSignal): Promise<CompanionChat> {
    const rows = await this.list(signal);
    const allowed = rows.find(row => row.id === id);
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(id)) {
      throw new MobileApiError('Esta conversa não está disponível no Companion.', 404);
    }
    // A bounded list is not a membership set. The authenticated detail endpoint
    // proves the immutable companion header even for older deep links.
    const data = await this.request(`/${encodeURIComponent(id)}`, 'GET', signal);
    if (!isRecord(data) || data['profile'] !== 'companion') {
      throw new MobileApiError('Não foi possível validar esta conversa.');
    }
    const detail = isRecord(data['chat']) ? data['chat'] : undefined;
    const confirmedId = detail?.['id'] ?? data['id'];
    if (confirmedId !== id) throw new MobileApiError('Não foi possível validar esta conversa.');
    return detail ? chat({ ...allowed, ...detail }) : allowed ?? chat({ id });
  }
  async create(signal?: AbortSignal): Promise<SessionId> {
    const data = await this.request('', 'POST', signal);
    if (!isRecord(data) || !isSessionId(data['id'])) {
      throw new MobileApiError('Não foi possível criar a conversa.');
    }
    return data['id'];
  }
}
