import { pathToFileURL } from 'node:url';
import { resolveHost } from '../common.mjs';
// Bind to the running DSH install; npx and the CLI may contain different SDK instances.
export const sdkPath = name => resolveHost(`@deepseek-ai/${name}`);
export const sdk = name => import(pathToFileURL(sdkPath(name)).href);
