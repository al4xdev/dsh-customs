// Format based on OpenAI Codex apply-patch parser; see REFERENCE.md.
// This adapter deliberately requires exact context instead of fuzzy matching.
export function parsePatch(patch) {
  const lines = patch.trim().split(/\r?\n/);
  if (lines.shift() !== '*** Begin Patch' || lines.pop() !== '*** End Patch') throw new Error('Expected *** Begin Patch and *** End Patch boundaries.');
  const operations = [];
  let i = 0;
  while (i < lines.length) {
    const header = /^\*\*\* (Add|Delete|Update) File: (.+)$/.exec(lines[i++]);
    if (!header) throw new Error(`Invalid file header at patch line ${i + 1}.`);
    const op = { kind: header[1].toLowerCase(), path: header[2], chunks: [] };
    if (op.kind === 'add') {
      const content = [];
      while (i < lines.length && !lines[i].startsWith('*** ')) {
        if (!lines[i].startsWith('+')) throw new Error('Added file lines must start with +.');
        content.push(lines[i++].slice(1));
      }
      op.content = content.length ? content.join('\n') + '\n' : '';
    } else if (op.kind === 'update') {
      if (lines[i]?.startsWith('*** Move to: ')) op.move = lines[i++].slice(13);
      while (i < lines.length && !lines[i].startsWith('*** ')) {
        let anchor;
        if (lines[i] === '@@' || lines[i].startsWith('@@ ')) anchor = lines[i++].slice(3);
        const chunk = { anchor, old: [], replacement: [], eof: false };
        while (i < lines.length && !lines[i].startsWith('@@') && !lines[i].startsWith('*** ')) {
          const line = lines[i++];
          if (![' ', '-', '+'].includes(line[0])) throw new Error(`Invalid change line ${i + 1}.`);
          if (line[0] !== '+') chunk.old.push(line.slice(1));
          if (line[0] !== '-') chunk.replacement.push(line.slice(1));
        }
        if (lines[i] === '*** End of File') { chunk.eof = true; i++; }
        if (!chunk.old.length && !chunk.replacement.length) throw new Error('Empty change chunk.');
        op.chunks.push(chunk);
      }
      if (!op.chunks.length && !op.move) throw new Error('Empty update operation.');
    }
    operations.push(op);
  }
  if (!operations.length) throw new Error('Patch has no operations.');
  return operations;
}
export function applyChunks(text, chunks) {
  const newline = text.endsWith('\n');
  const source = text === '' ? [] : text.split('\n');
  if (newline) source.pop();
  const edits = [], covered = new Set();
  let cursor = 0;
  for (const chunk of chunks) {
    if (chunk.anchor) {
      const index = source.indexOf(chunk.anchor, cursor);
      if (index < 0) throw new Error(`Anchor not found: ${chunk.anchor}`);
      covered.add(index); cursor = index + 1;
    }
    let index;
    if (!chunk.old.length) { index = source.length; if (source.length) covered.add(source.length - 1); }
    else {
      const matches = [];
      for (let j = cursor; j <= source.length - chunk.old.length; j++) {
        if (chunk.eof && j + chunk.old.length !== source.length) continue;
        if (chunk.old.every((line, k) => source[j + k] === line)) matches.push(j);
      }
      if (matches.length !== 1) {
        const hint = !matches.length && chunk.anchor === chunk.old[0] ? ` Lines are searched strictly after the "@@ ${chunk.anchor}" anchor line (Codex semantics); do not repeat the anchor as the first context line.` : '';
        throw new Error(`Expected unique exact context, found ${matches.length}; re-read or add context.${hint}`);
      }
      index = matches[0];
      chunk.old.forEach((_, k) => covered.add(index + k));
    }
    edits.push({ index, count: chunk.old.length, replacement: chunk.replacement });
    cursor = index + chunk.old.length;
  }
  for (const edit of edits.toReversed()) source.splice(edit.index, edit.count, ...edit.replacement);
  return { after: source.length ? source.join('\n') + (newline || text === '' ? '\n' : '') : '', covered: [...covered] };
}
