// Native UI presentation for apply_patch: derive diff cards from the patch
// grammar plus the recovery receipt, so a capable UI renders like native
// write/edit instead of dumping the raw receipt JSON.
//
// These hooks run inside the tool-output pipeline, where a throw becomes a hard
// projection error (live) or breaks replay, so every entry point is total and
// returns undefined/{} instead of throwing. The model-facing text stays the
// untouched receipt: presentation only reformats it for the UI.
import { basename, dirname } from 'node:path';

import { parsePatch } from './parser.mjs';

/** States that mean the operation actually landed on disk. */
const APPLIED_STATES = new Set(['changed', 'partial']);

function textOf(blocks) {
  return Array.isArray(blocks) ? blocks.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('') : '';
}

/** Narrow opaque output/receipt text to a receipt object, or undefined. */
export function parseReceipt(text) {
  if (typeof text !== 'string' || text.trim() === '') return undefined;
  try {
    const receipt = JSON.parse(text);
    return receipt && typeof receipt === 'object' && Array.isArray(receipt.operations) ? receipt : undefined;
  } catch { return undefined; }
}

/** Whether a value is a valid FileDiff, mirroring the native tools' narrowing. */
export function isFileDiff(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value) && typeof value.path === 'string' && (value.oldText === null || typeof value.oldText === 'string') && typeof value.newText === 'string';
}

function operationsOf(patch) {
  try { return parsePatch(patch); } catch { return undefined; }
}

function fileCount(count) {
  return `${count} file${count === 1 ? '' : 's'}`;
}

function countByKind(operations) {
  const counts = { added: 0, updated: 0, moved: 0, deleted: 0 };
  for (const operation of operations) {
    if (operation.kind === 'add') counts.added++;
    else if (operation.kind === 'delete') counts.deleted++;
    else if (operation.move) counts.moved++;
    else counts.updated++;
  }
  return counts;
}

/**
 * Diff entries for the patch's operations. `records` are the receipt's
 * per-operation records: when supplied, only operations the receipt confirms as
 * applied produce a diff. The patch grammar carries no file body for Delete or
 * a bodyless Move, so those are reported in the card title instead of a diff.
 */
export function diffsOf(operations, records) {
  const confirmed = Array.isArray(records);
  const diffs = [];
  for (let index = 0; index < operations.length; index++) {
    const operation = operations[index];
    const record = confirmed ? records[index] : undefined;
    if (confirmed && !APPLIED_STATES.has(record?.state)) continue;
    const path = record?.output ?? operation.move ?? operation.path;
    if (operation.kind === 'add' && typeof operation.content === 'string') diffs.push({ path, oldText: null, newText: operation.content });
    else if (operation.kind === 'update') for (const chunk of operation.chunks ?? []) diffs.push({ path, oldText: chunk.old.length ? chunk.old.join('\n') : null, newText: chunk.replacement.join('\n') });
  }
  return diffs.filter(isFileDiff);
}

function patchTitle(prefix, operations, fallbackTotal) {
  if (!operations) return `${prefix} · ${fileCount(fallbackTotal)}`;
  const counts = countByKind(operations);
  const parts = [];
  if (counts.added) parts.push(`${counts.added} added`);
  if (counts.updated) parts.push(`${counts.updated} updated`);
  if (counts.moved) parts.push(`${counts.moved} moved`);
  if (counts.deleted) parts.push(`${counts.deleted} deleted`);
  return `${prefix} · ${fileCount(operations.length)}${parts.length ? ` (${parts.join(', ')})` : ''}`;
}

function locationList(operations) {
  return [...new Set(operations.map(operation => operation.move ?? operation.path))].map(path => ({ path }));
}

/** Pending-call view: the proposed change the patch asks for. */
export function patchCallView(args) {
  const fallback = { card: 'generic', title: 'Apply patch', kind: 'edit' };
  try {
    const operations = operationsOf(args?.patch);
    if (!operations) return fallback;
    const title = patchTitle('Apply patch', operations, 0);
    const diffs = diffsOf(operations, undefined);
    if (!diffs.length) return { card: 'generic', title, kind: operations.every(operation => operation.kind === 'delete') ? 'delete' : 'edit', locations: locationList(operations) };
    return { card: 'diff', title, diffs, locations: locationList(operations) };
  } catch { return fallback; }
}

function appliedTitle(receipt, operations) {
  return patchTitle('Applied patch', operations, receipt.operations.length);
}

function incompleteTitle(receipt) {
  const changed = receipt.operations.filter(record => APPLIED_STATES.has(record.state)).length;
  return `Patch incomplete · ${changed} of ${fileCount(receipt.operations.length)} changed`;
}

/** Compact, explicit receipt summary for a partial/uncertain outcome (no raw JSON). */
function incompleteSummary(receipt) {
  const lines = [`Patch incomplete — ${receipt.operations.filter(record => record.state === 'changed').length} of ${fileCount(receipt.operations.length)} changed.`];
  for (const record of receipt.operations) lines.push(`${record.state ?? 'prepared'}  ${record.output ?? record.path}${record.error ? `: ${record.error}` : ''}`);
  for (const path of receipt.not_attempted ?? []) lines.push(`not attempted  ${path}`);
  if (receipt.manifest) lines.push(`recovery manifest: ${receipt.manifest}`);
  return lines.join('\n');
}

/**
 * Structured result-time payload persisted with the session log: the confirmed
 * diff set plus the receipt text, so replay can rebuild the card without the
 * live tool value.
 */
export function patchMeta(args, receiptText) {
  try {
    const receipt = parseReceipt(receiptText);
    if (!receipt) return {};
    const meta = { version: 1, status: receipt.status, receipt: receiptText, diffs: [] };
    const operations = operationsOf(args?.patch);
    if (operations) meta.diffs = diffsOf(operations, receipt.operations);
    return meta;
  } catch { return {}; }
}

/** Completed-call view: only confirmed changes render as applied diffs. */
export function patchResultView(args, result) {
  if (result?.isError) return undefined;
  const meta = result?.meta;
  const receipt = parseReceipt(meta?.receipt) ?? parseReceipt(textOf(result?.content));
  if (!receipt) return undefined;
  const operations = operationsOf(args?.patch);
  if (receipt.status !== 'applied') {
    if (receipt.status !== 'partial_failure') return undefined;
    return { card: 'generic', title: incompleteTitle(receipt), content: [{ type: 'text', text: incompleteSummary(receipt) }] };
  }
  // `applied` means every operation landed; still prefer the persisted
  // confirmed set and fall back to the patch argument when meta is absent.
  const persisted = Array.isArray(meta?.diffs) ? meta.diffs.filter(isFileDiff) : [];
  const diffs = persisted.length ? persisted : operations ? diffsOf(operations, receipt.operations) : [];
  const title = appliedTitle(receipt, operations);
  if (!diffs.length) return { card: 'generic', title, kind: 'edit' };
  return { card: 'diff', title, diffs };
}

function shortManifest(manifest) {
  if (typeof manifest !== 'string' || manifest === '') return '';
  const parent = basename(dirname(manifest));
  return parent && parent !== '.' ? parent : manifest;
}

/** Pending-call view for apply_patch_undo. */
export function undoCallView(args) {
  try {
    const label = shortManifest(args?.manifest);
    return { card: 'generic', title: label ? `Undo patch · ${label}` : 'Undo patch', kind: 'edit' };
  } catch { return { card: 'generic', title: 'Undo patch', kind: 'edit' }; }
}

function undoRecords(receipt) {
  return receipt.operations.map(record => {
    const state = record.undo?.state ?? (record.state === undefined || record.state === 'unchanged' ? 'unchanged' : 'not_restored');
    return { path: record.output ?? record.path, state, error: record.undo?.error };
  });
}

function undoSummary(receipt) {
  const records = undoRecords(receipt);
  const restored = records.filter(record => record.state === 'restored').length;
  const done = records.filter(record => record.state === 'restored' || record.state === 'unchanged').length;
  const title = records.length === done ? `Undo patch · ${fileCount(restored)} restored` : `Undo patch incomplete · ${restored} of ${fileCount(records.length)} restored`;
  const lines = [];
  for (const record of records) lines.push(`${record.state}  ${record.path}${record.error ? `: ${record.error}` : ''}`);
  if (receipt.status !== 'undone' && receipt.manifest) lines.push(`recovery manifest: ${receipt.manifest}`);
  return { title, text: lines.join('\n') };
}

/** Persisted result-time payload for apply_patch_undo. */
export function undoMeta(_args, receiptText) {
  try {
    const receipt = parseReceipt(receiptText);
    return receipt ? { version: 1, status: receipt.status, receipt: receiptText } : {};
  } catch { return {}; }
}

/** Completed-call view: a compact undo summary instead of the receipt JSON. */
export function undoResultView(_args, result) {
  if (result?.isError) return undefined;
  const meta = result?.meta;
  const receipt = parseReceipt(meta?.receipt) ?? parseReceipt(textOf(result?.content));
  if (!receipt) return undefined;
  const { title, text } = undoSummary(receipt);
  return { card: 'generic', title, content: [{ type: 'text', text }] };
}
