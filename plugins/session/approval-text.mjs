import { createHash } from 'node:crypto';

// Shared by every Companion approval card (send, resume, session_create, Bash,
// download). The owner approves what the card SHOWS; the effect uses the exact
// literal. Anything that renders invisibly or reorders text breaks that link.

// Refused outright in a literal that another agent will read or Bash will run:
// Unicode tags (invisible "ASCII smuggling" that models still read), bidi marks,
// embeddings, overrides and isolates, private use, lone surrogates (replaced in
// UTF-8 transport), CR (rewrites a rendered line) and every C0/C1 control
// except LF and TAB. None has a legitimate use in such a literal.
const REFUSED = /[\u{E0000}-\u{E007F}\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069\p{Co}\p{Cs}\0-\x08\x0B-\x1F\x7F-\x9F]/u;
// Escaped in every preview: all of the above plus invisible characters with
// rare legitimate uses (ZWJ emoji sequences, ZWNJ, BOM, soft hyphen, variation
// selectors, combining grapheme joiner, Khmer/Mongolian invisible marks, Hangul
// fillers), unassigned code points and line separators.
const HIDDEN = /[\p{Cf}\p{Co}\p{Cn}\p{Cs}\p{Zl}\p{Zp}\0-\x08\x0B-\x1F\x7F-\x9F\uFE00-\uFE0F\u{E0100}-\u{E01EF}\u034F\u17B4\u17B5\u180B-\u180F\u115F\u1160\u3164\uFFA0]/gu;

const codePoint = character => `U+${character.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`;
// UTF-16 escapes, so an escaped astral character is still valid, reversible JSON.
const escape = character => [...Array(character.length).keys()].map(index => `\\u${character.charCodeAt(index).toString(16).padStart(4, '0')}`).join('');

/**
 * CRLF is how Windows/pasted text breaks lines, not a hiding trick: fold it to LF
 * BEFORE the card and the digest are built, so the approved bytes are exactly the
 * delivered bytes. A lone CR (which can overwrite a rendered line) stays refused.
 */
export function normalizeNewlines(text) { return typeof text === 'string' ? text.replace(/\r\n/g, '\n') : text; }
/** First refused character as `U+XXXX`, or null. */
export function refusedCharacter(text) {
  const match = REFUSED.exec(text);
  return match ? codePoint(match[0]) : null;
}
export function hiddenCount(text) { return [...text.matchAll(HIDDEN)].length; }
export function escapeHidden(text) { return String(text).replace(HIDDEN, escape); }
export function sha256(text) { return createHash('sha256').update(text, 'utf8').digest('hex'); }

/** Untrusted one-line field (title, cwd, path): raw when plainly visible, else an escaped JSON string. */
export function inlineForApproval(value) {
  const text = String(value);
  return hiddenCount(text) || text.includes('\n') ? escapeHidden(JSON.stringify(text)) : text;
}

/**
 * Size, digest and a faithful rendering of a literal. Plain text stays readable;
 * any hidden character switches to a complete escaped JSON string (never
 * truncated), so the owner sees exactly where each one sits.
 */
export function literalForApproval(text) {
  const hidden = hiddenCount(text);
  return { bytes: Buffer.byteLength(text, 'utf8'), sha256: sha256(text), hidden, display: hidden ? escapeHidden(JSON.stringify(text)) : text };
}

/** Labelled approval block; the literal is always LAST so it cannot spoof the trusted lines above it. */
export function literalBlock(label, text) {
  const literal = literalForApproval(text);
  return [
    `${label}: ${literal.bytes} bytes UTF-8, sha256 ${literal.sha256}`,
    ...(literal.hidden ? [`ATENÇÃO: ${literal.hidden} caractere(s) invisível(is) ou de controle, exibidos escapados (\\uXXXX) em JSON; o efeito usa o texto original.`] : []),
    `${label} (literal completo):`,
    literal.display,
  ].join('\n');
}
