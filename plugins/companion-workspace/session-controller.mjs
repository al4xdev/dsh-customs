import { resolveHost } from '../common.mjs';
import { createCompanionSessionController } from './controller-policy.mjs';

const { default: SessionController } = await import(resolveHost('@deepseek-ai/dsh-api-session-controller'));
const { RemoteError } = await import(resolveHost('@deepseek-ai/dsh-typert-protocol'));

// Mount only in the companion profile's distinct native-controller row; the
// generated composition disables the stock row instead of patching its name.
// No SDK changes, extra RPC registration, or alternate agent/writer ownership.
export default createCompanionSessionController(SessionController, RemoteError);
