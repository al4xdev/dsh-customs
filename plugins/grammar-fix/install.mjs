import { readFileSync, writeFileSync, copyFileSync, renameSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
const base = `${homedir()}/.dsh/profiles/dsh-tui/node_modules/@deepseek-harness-tui/dsh-tui`;
const file = `${base}/lib/types/components/PromptInput.js`;
let source = readFileSync(file, 'utf8');
if (!source.includes("Symbol.for('alex.dsh.grammar-fix')")) {
  const replace = (before, after) => {
    if (source.split(before).length !== 2) throw new Error('The TUI version has changed; manual adaptation is required.');
    source = source.replace(before, after);
  };
  replace('    const editorBusyRef = React.useRef(false);', `    const editorBusyRef = React.useRef(false);
    const grammarAbortRef = React.useRef(null);
    React.useEffect(() => () => grammarAbortRef.current?.abort(), []);`);
  replace('        if (editorBusyRef.current)\n            return;', `        if (editorBusyRef.current) {
            if (grammarAbortRef.current && (key.escape || (key.ctrl && input === 'c'))) {
                event?.stopImmediatePropagation();
                grammarAbortRef.current.abort();
            }
            return;
        }`);
  replace("        if (actionMatches('editor', input, key)) {", `        if (input === 'g' && key.ctrl && !key.shift && !key.meta && !key.super) {
            event?.stopImmediatePropagation();
            const grammar = globalThis[Symbol.for('alex.dsh.grammar-fix')];
            if (!grammar) {
                channel.notify('Grammar fixer unavailable in this profile.', { color: 'warning' });
                return;
            }
            if (!value.trim() || value.startsWith('/')) return;
            syncImageGeneration();
            advanceDraftRevision();
            const lease = captureDraftImageLease();
            const abort = new AbortController();
            grammarAbortRef.current = abort;
            editorBusyRef.current = true;
            void (async () => {
                try {
                    const corrected = await grammar.fix(value, { provider: channel.provider, model: channel.model }, abort.signal);
                    if (!draftImageLeaseIsCurrent(lease) || abort.signal.aborted) return;
                    const beforeBlock = foldBlockRef.current;
                    updateFoldBlock(null);
                    setInput(corrected, corrected.length, 'step', beforeBlock);
                    setSelectedCommand(0);
                    setFileSelected(0);
                    channel.notify('Grammar corrected. Review before sending.');
                } catch (error) {
                    if (draftImageLeaseIsCurrent(lease)) channel.notify(abort.signal.aborted ? 'Correction canceled; draft preserved.' : String(error?.message ?? error), { color: 'warning' });
                } finally {
                    grammarAbortRef.current = null;
                    editorBusyRef.current = false;
                }
            })();
            return;
        }
        if (actionMatches('editor', input, key)) {`);
  const backup = `${file}.grammar-fix.bak`;
  if (!existsSync(backup)) copyFileSync(file, backup);
  writeFileSync(`${file}.grammar-fix.tmp`, source);
  renameSync(`${file}.grammar-fix.tmp`, file);
}
function adapt(relative, replacements) {
  const target = `${base}/lib/types/${relative}`;
  let text = readFileSync(target, 'utf8');
  if (text.includes('alexGrammarLaunchpad')) return;
  for (const [before, after] of replacements) {
    if (text.split(before).length !== 2) throw new Error(`The structure of ${relative} has changed.`);
    text = text.replace(before, after);
  }
  if (!existsSync(`${target}.grammar-fix.bak`)) copyFileSync(target, `${target}.grammar-fix.bak`);
  writeFileSync(`${target}.grammar-fix.tmp`, text);
  renameSync(`${target}.grammar-fix.tmp`, target);
}
adapt('screens/Chat.js', [
  ['_jsx(Launchpad, { query: launchpadDraft,', '_jsx(Launchpad, { alexGrammarLaunchpad: true, grammarModel: channel.model, provider: channel.provider, query: launchpadDraft,'],
]);
adapt('screens/Launchpad.js', [
  ["import React from 'react';", "import React from 'react';\nimport { editInExternalEditor } from '../utils/externalEditor.js';"],
  ['export function Launchpad({ query,', 'export function Launchpad({ alexGrammarLaunchpad, grammarModel, provider, query,'],
  ['    const { columns, rows } = useTerminalSize();', `    const alexGrammarAbort = React.useRef(null);
    const alexEditorBusy = React.useRef(false);
    const alexGrammarUndo = React.useRef(null);
    React.useEffect(() => () => alexGrammarAbort.current?.abort(), []);
    const { columns, rows } = useTerminalSize();`],
  ['        const composing = key.ctrl || key.meta || key.super;', `        if (alexEditorBusy.current) {
            event?.stopImmediatePropagation();
            if (key.escape || (key.ctrl && input === 'c')) alexGrammarAbort.current?.abort();
            return;
        }
        if (key.ctrl && !key.shift && input === 'z' && alexGrammarUndo.current !== null) {
            event?.stopImmediatePropagation();
            const previous = alexGrammarUndo.current;
            alexGrammarUndo.current = null;
            onQueryChange(previous, previous.length);
            return;
        }
        const grammarPressed = input === 'g' && key.ctrl && !key.shift && !key.meta && !key.super;
        if (grammarPressed || actionMatches('editor', input, key)) {
            event?.stopImmediatePropagation();
            if (!query.trim() || (grammarPressed && query.startsWith('/'))) return;
            const grammar = globalThis[Symbol.for('alex.dsh.grammar-fix')];
            if (grammarPressed && !grammar) { showPasteNotice('Grammar fixer unavailable.'); return; }
            const original = query;
            const abort = new AbortController();
            alexGrammarAbort.current = abort;
            alexEditorBusy.current = true;
            void (async () => {
                try {
                    const outcome = grammarPressed
                        ? { kind: 'edited', text: await grammar.fix(original, { provider, model: grammarModel }, abort.signal, showPasteNotice) }
                        : await editInExternalEditor(original);
                    if (abort.signal.aborted || queryRef.current !== original) return;
                    if (outcome.kind === 'edited') {
                        alexGrammarUndo.current = original;
                        onQueryChange(outcome.text, outcome.text.length);
                        showPasteNotice(grammarPressed ? 'Grammar corrected. Review before sending.' : 'Draft updated.');
                    } else showPasteNotice('External editor unavailable.');
                } catch (error) {
                    if (!abort.signal.aborted) showPasteNotice(String(error?.message ?? error));
                } finally {
                    alexGrammarAbort.current = null;
                    alexEditorBusy.current = false;
                }
            })();
            return;
        }
        const composing = key.ctrl || key.meta || key.super;`],
]);
console.log('Native grammar fixer integration installed.');
