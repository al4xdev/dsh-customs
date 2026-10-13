import { build } from 'esbuild';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(project, 'dist');
const runtimeDirectory = process.env.DSH_RUNTIME_NODE_MODULES ?? join(homedir(), '.local/share/dsh-cli/node_modules');
const runtimeVersion = '0.2.0-rc.2';
const manifest = JSON.parse(await readFile(join(runtimeDirectory, '@deepseek-ai/dsh-web-frontend/package.json'), 'utf8'));
if (manifest.version !== runtimeVersion) throw Error(`Unsupported Web runtime version; expected ${runtimeVersion}`);
await mkdir(output, { recursive: true });
const digest = value => createHash('sha256').update(value).digest('hex').slice(0, 20);
async function compile(entry, id, filename, inject) {
  const result = await build({ entryPoints: [join(project, 'src', entry)], bundle: true, write: false, format: 'cjs', platform: 'browser', target: ['es2022'], jsx: 'automatic', minify: false, external: ['react', 'react/*', '@deepseek-ai/*'], plugins: [{ name: 'native-client-id', setup(builder) { builder.onResolve({ filter: /^@deepseek-ai\/[^/]+\/client$/ }, args => ({ path: args.path.replace(/\/client$/, ''), external: true })); } }] });
  // Runtime seeds own React/store singletons. Bundling another instance would
  // split hook/context identity from the upstream conversation renderer.
  const code = `window.__ModuleLoader__.load({id:${JSON.stringify(id)},factory(require){const module={exports:{}};const exports=module.exports;\n${result.outputFiles[0].text}\nreturn module.exports;}});\n`;
  await writeFile(join(output, filename), code);
  return { id, url: `/mobile-assets/${filename}`, rev: digest(code), inject };
}
const workspace = await compile('workspace.ts', '@deepseek-ai/dsh-client-ui-workspace', 'workspace.js', ['@deepseek-ai/dsh-api-workspace-controller']);
const mobile = await compile('index.tsx', '@alex/mobile-companion', 'mobile.js', ['@deepseek-ai/dsh-client-ui-workspace', '@deepseek-ai/dsh-client-ui-conversation', '@deepseek-ai/dsh-client-ui-session', '@deepseek-ai/dsh-client-connection']);
const styles = await Promise.all(['mobile.css', 'motion-navigation.css', 'motion-messages.css'].map(filename => readFile(join(project, 'styles', filename), 'utf8')));
await writeFile(join(output, 'mobile.css'), styles.join('\n'));
await mkdir(join(output, 'licenses'), { recursive: true });
await copyFile(join(runtimeDirectory, '@deepseek-ai/dsh-web-app/LICENSE'), join(output, 'licenses/DeepSeek-MIT.txt'));
await copyFile(join(runtimeDirectory, '@deepseek-ai/dsh-client-ui-theme/lib/styles/Montserrat-OFL.txt'), join(output, 'licenses/Montserrat-OFL.txt'));
for (const filename of ['icon.svg', 'mobile.webmanifest']) await copyFile(join(project, 'public', filename), join(output, filename));
await writeFile(join(output, 'asset-manifest.json'), JSON.stringify({ runtimeVersion, runtimeDirectory, workspace, mobile, stylesheet: '/mobile-assets/mobile.css' }, null, 2));
console.log(`Built mobile chat shell for DSH ${runtimeVersion}; upstream renderer retained.`);
