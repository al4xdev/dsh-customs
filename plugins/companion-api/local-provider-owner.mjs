import { sdk } from './sdk.mjs';
import { appModelError } from './app-models.mjs';
const PiAi = await sdk('dsh-llm-pi-ai');
const unavailable = () => appModelError('model-unavailable');

/** One-time public METADATA locator, not endpoint/adapter attestation or discovery.
 * The unchanged binding kernel proves route/map/registration ownership next.
 * No provider configuration, auth reference, model list or private patch is read here.
 */
export function locateLocalProviderOwner(ctx) {
  try {
    const loader = ctx.get('loader'), llm = ctx.get('llm');
    const rows = llm.listConfigurableProviders().filter(row => row.provider === 'strata-local');
    if (rows.length !== 1) throw unavailable();
    const row = rows[0];
    if (typeof row.settingsNs !== 'string' || !row.settingsNs || Object.hasOwn(row, 'error') ||
        !Array.isArray(row.settingsPath) || row.settingsPath.length !== 2 || row.settingsPath[0] !== 'providers' || row.settingsPath[1] !== 'strata-local') throw unavailable();
    const candidates = [...loader.entries()].filter(entry => !entry.disabled && entry.options.id === row.settingsNs &&
      entry.fiber?.state === 2 && entry.fiber.uid !== null && entry.fiber.runtime.callback === PiAi.apply);
    if (candidates.length !== 1) throw unavailable();
    const entry = candidates[0];
    if (typeof entry.id !== 'string' || !entry.id || loader.resolve(entry.id) !== entry) throw unavailable();
    return entry;
  } catch { throw unavailable(); }
}
