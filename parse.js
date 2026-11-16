// Fast drop-in replacement for marked 18.1.3 parse() with its default options
// (GFM on, breaks off, pedantic off). Returns byte-identical HTML for every
// input. Two phases: a line-oriented block lexer, then a position-indexed
// inline scanner (no slicing of the remaining string per token).
//
// Design notes:
// - Inline rendering is direct (strings, no token objects). Link text is
//   parsed recursively; image alt text is parsed with a plain-text renderer.
// - Block parsing builds a small node list first (so link reference
//   definitions anywhere in the document are visible to every inline run),
//   then a render pass walks the nodes.
// - Emphasis/strong uses marked's forward scan (delimiter budget + the
//   rule of three), strikethrough the same shape without the rule of three.

const SPACE = 32, TAB = 9, LF = 10, CR = 13;

// ---- ASCII lookup tables (code < 128) ----
const IS_SPACE = new Uint8Array(128);   // Unicode whitespace, ASCII subset
const IS_PUNCT = new Uint8Array(128);   // ASCII punctuation incl. ~
const IS_WORD = new Uint8Array(128);    // [A-Za-z0-9_]
const IS_ALNUM = new Uint8Array(128);
const IS_EMAIL_LOCAL = new Uint8Array(128); // [A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]
const IS_DIGIT = new Uint8Array(128);
{
  for (const c of [9, 10, 11, 12, 13, 32]) IS_SPACE[c] = 1;
  const punct = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";
  for (let i = 0; i < punct.length; i++) IS_PUNCT[punct.charCodeAt(i)] = 1;
  for (let c = 48; c <= 57; c++) { IS_WORD[c] = 1; IS_ALNUM[c] = 1; IS_DIGIT[c] = 1; }
  for (let c = 65; c <= 90; c++) { IS_WORD[c] = 1; IS_ALNUM[c] = 1; }
  for (let c = 97; c <= 122; c++) { IS_WORD[c] = 1; IS_ALNUM[c] = 1; }
  IS_WORD[95] = 1;
  const local = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789.!#$%&'*+/=?^_`{|}~-";
  for (let i = 0; i < local.length; i++) IS_EMAIL_LOCAL[local.charCodeAt(i)] = 1;
}

// Unicode-aware char classes for a single char (string of length 1 or 2).
// Returns 0 = whitespace, 1 = punctuation (P/S, except ~ in GFM), 2 = other
// (~ counts as "other" in GFM, like a word character, for flanking).
const _classCache = new Map();
function charClass(ch) {
  const code = ch.charCodeAt(0);
  if (code < 128) {
    if (IS_SPACE[code]) return 0;
    if (IS_PUNCT[code] && code !== 126) return 1; // ~ is not punctuation here
    return 2;
  }
  let v = _classCache.get(ch);
  if (v === undefined) {
    if (/\s/.test(ch)) v = 0;
    else if (ch !== '~' && /[\p{P}\p{S}]/u.test(ch)) v = 1;
    else v = 2;
    _classCache.set(ch, v);
  }
  return v;
}
// Is the char Unicode alphanumeric (for the intraword _ rule)?
function isAlnumUni(ch) {
  const code = ch.charCodeAt(0);
  if (code < 128) return IS_ALNUM[code] === 1;
  return /[\p{L}\p{N}]/u.test(ch);
}
// Is the char punctuation-or-whitespace (marked's "punctuation" test, which
// also accepts whitespace but never * or _)?
function isPunctOrSpace(ch) {
  if (ch === '' || ch === '*' || ch === '_') return false;
  return charClass(ch) !== 2;
}

// ---- text helpers ----
// P: escape HTML. encode=true escapes & < > " '; otherwise escapes < > " '
// and only those & that do not start a valid entity/character reference.
const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;
const ESC_RE_NOENC = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
function esc(s, encode) {
  if (encode) {
    if (!ESC_RE.test(s)) return s;
    ESC_RE.lastIndex = 0;
    return s.replace(ESC_RE, (c) => ESC_MAP[c]);
  }
  if (!ESC_RE_NOENC.test(s)) return s;
  ESC_RE_NOENC.lastIndex = 0;
  return s.replace(ESC_RE_NOENC, (c) => ESC_MAP[c]);
}
// Ie: decode numeric character references in text; a bare & becomes &amp;.
// Named entities are left alone (the browser decodes them).
const ENT_RE = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
function decodeEntities(s) {
  if (s.indexOf('&') === -1) return s;
  return s.replace(ENT_RE, (m, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const cp = dec !== undefined ? parseInt(dec, 10) : parseInt(hex, 16);
    if (cp === 0 || cp > 1114111 || (cp >= 55296 && cp <= 57343)) return '\uFFFD';
    if (cp === 38) return '&amp;';
    return String.fromCodePoint(cp);
  });
}
// he: encode a link href the way marked does (encodeURI, %25 back to %).
function encodeHref(s) {
  try {
    return encodeURI(s).replace(/%25/g, '%');
  } catch {
    return null;
  }
}
// F: normalise a link label (trim, collapse whitespace, Unicode case fold).
function normLabel(s) {
  return s.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}
// L: strip trailing occurrences of ch from s (returns the stripped string).
function stripTrailing(s, ch) {
  let n = s.length;
  while (n > 0 && s.charCodeAt(n - 1) === ch.charCodeAt(0)) n--;
  return s.slice(0, n);
}
// Count trailing occurrences of ch in s.
function countTrailing(s, ch) {
  let n = 0;
  for (let i = s.length - 1; i >= 0 && s.charCodeAt(i) === ch.charCodeAt(0); i--) n++;
  return n;
}
// J: expand tabs in s, starting at column col (tab = next multiple of 4).
function expandTabs(s, col) {
  if (s.indexOf('\t') === -1) return s;
  let out = '', c = col;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\t') {
      const n = 4 - (c % 4);
      out += '    '.slice(0, n);
      c += n;
    } else {
      out += ch;
      c++;
    }
  }
  return out;
}
// Indent of a line in columns (tab = next multiple of 4). Returns
// { cols, idx } where idx is the string index where the indent ends.
function indentOf(line) {
  let cols = 0, i = 0;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c === 32) { cols++; i++; }
    else if (c === TAB) { cols += 4 - (cols % 4); i++; }
    else break;
  }
  return { cols, idx: i };
}
// Remove n columns of indent from the start of a line. A tab that straddles
// the boundary becomes spaces for the part that remains.
// ge: trim trailing blank lines — 0 or 1 kept, 2+ stripped entirely.
function trimTrailingBlanks(s) {
  const e = s.split('\n');
  let t = e.length - 1;
  for (; t >= 0 && /^[ \t]*$/.test(e[t]);) t--;
  return e.length - t <= 2 ? s : e.slice(0, t + 1).join('\n');
}
function stripIndent(line, n) {
  let cols = 0, i = 0;
  while (i < line.length && cols < n) {
    const c = line.charCodeAt(i);
    if (c === 32) { cols++; i++; }
    else if (c === TAB) {
      const w = 4 - (cols % 4);
      if (cols + w <= n) { cols += w; i++; }
      else {
        // tab straddles the boundary: it becomes spaces
        return ' '.repeat(cols + w - n) + line.slice(i + 1);
      }
    } else break;
  }
  return line.slice(i);
}
// Is the line blank (only spaces/tabs)?
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== TAB) return false;
  }
  return true;
}

// ============================= INLINE =============================
// All inline tokenizers are sticky (flag y) and run on the whole inline
// source with lastIndex = current position: no slicing of the remainder.

// ---- regex pieces ----
const PUNCT_CLASS = '[\\p{P}\\p{S}]';
const LDELIM_SRC = '(?:\\*+(?:((?!\\*)(?!~)' + PUNCT_CLASS + ')|([^\\s*]))?)|_+(?:((?!_)(?!~)' + PUNCT_CLASS + ')|([^\\s_]))?';
const EM_STRONG_LDELIM = new RegExp(LDELIM_SRC, 'uy');
const RDELIM_AST_SRC = '^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)(?!~)[\\p{P}\\p{S}](\\*+)(?=[\\s]|$)|(?:[^\\s\\p{P}\\p{S}]|~)(\\*+)(?!\\*)(?=(?!~)[\\s\\p{P}\\p{S}]|$)|(?!\\*)(?!~)[\\s\\p{P}\\p{S}](\\*+)(?=(?:[^\\s\\p{P}\\p{S}]|~))|[\\s](\\*+)(?!\\*)(?=(?!~)[\\p{P}\\p{S}])|(?!\\*)(?!~)[\\p{P}\\p{S}](\\*+)(?!\\*)(?=(?!~)[\\p{P}\\p{S}])|(?:[^\\s\\p{P}\\p{S}]|~)(\\*+)(?=(?:[^\\s\\p{P}\\p{S}]|~))';
const RDELIM_AST = new RegExp(RDELIM_AST_SRC, 'gu');
const RDELIM_UND_SRC = '^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)[\\p{P}\\p{S}](_+)(?=[\\s]|$)|[^\\s\\p{P}\\p{S}](_+)(?!_)(?=[\\s\\p{P}\\p{S}]|$)|(?!_)[\\s\\p{P}\\p{S}](_+)(?=[^\\s\\p{P}\\p{S}])|[\\s](_+)(?!_)(?=[\\p{P}\\p{S}])|(?!_)[\\p{P}\\p{S}](_+)(?!_)(?=[\\p{P}\\p{S}])';
const RDELIM_UND = new RegExp(RDELIM_UND_SRC, 'gu');
const DEL_LDELIM = new RegExp('~~?(?:((?!~)' + PUNCT_CLASS + ')|[^\\s~])', 'uy');
const DEL_RDELIM_SRC = '^[^~]+(?=[^~])|(?!~)[\\p{P}\\p{S}](~~?)(?=[\\s]|$)|[^\\s\\p{P}\\p{S}](~~?)(?!~)(?=[\\s\\p{P}\\p{S}]|$)|(?!~)[\\s\\p{P}\\p{S}](~~?)(?=[^\\s\\p{P}\\p{S}])|[\\s](~~?)(?!~)(?=[\\p{P}\\p{S}])|(?!~)[\\p{P}\\p{S}](~~?)(?!~)(?=[\\p{P}\\p{S}])|[^\\s\\p{P}\\p{S}](~~?)(?=[^\\s\\p{P}\\p{S}])';
const DEL_RDELIM = new RegExp(DEL_RDELIM_SRC, 'gu');
const ESCAPE_RE = /\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/y;
const CODE_RE = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/y;
const BR_RE = /( {2,}|\\)\n(?!\s*$)[ \t]*/y;
const AUTOLINK_RE = new RegExp('<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\\s\\x00-\\x1f<>]*|[a-zA-Z0-9.!#$%&\'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_]))>', 'y');
const EMAIL_NO_GROUP = '[a-zA-Z0-9._+-]+@[a-zA-Z0-9-_]+(?:\\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\\w-])';
const URL_RE = new RegExp('(?:mailto:' + EMAIL_NO_GROUP + '|xmpp:' + EMAIL_NO_GROUP + '(?:\\/[A-Za-z0-9@.]+)?)|((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\\/\\/|www\\.)(?:[a-zA-Z0-9\\-]+\\.?)+[^\\s<]*|[a-zA-Z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\\w-])', 'y');
const BACKPEDAL_RE = /(?:[^?!.,:;*_'\"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'\"~)]+(?!$))+/;
const TAG_RE = new RegExp('<!--(?:-?>|[\\s\\S]*?(?:-->|$))|<\\/[a-zA-Z][a-zA-Z0-9-]*\\s*>|<[a-zA-Z][a-zA-Z0-9-]*(?:\\s+[a-zA-Z:_][\\w.:-]*(?:\\s*=\\s*"[^"]*"|\\s*=\\s*\'[^\']*\'|\\s*=\\s*[^\\s"\'=<>`]+)?)*?\\s*\\/?>|<\\?[\\s\\S]*?\\?>|<![a-zA-Z]+\\s[\\s\\S]*?>|<!\\[CDATA\\[[\\s\\S]*?\\]\\]>', 'y');
const START_A_TAG = /^<a /i;
const END_A_TAG = /^<\/a>/i;
const START_PRE_TAG = /^<(pre|code|kbd|script)(\s|>)/i;
const END_PRE_TAG = /^<\/(pre|code|kbd|script)(\s|>)/i;
const ANY_PUNCT_RE = /\\([\p{P}\p{S}])/gu;
const LINK_LABEL_SRC = '(?:\\[(?:\\[(?:\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|[^\\[\\]\\\\])*?\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\])|[^\\[\\]`])*?';
const REF_LABEL_SRC = '(?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\\\n]|\\n(?![ \\t]*\\n))+';
// marked's blockSkip link pattern (sticky): the label may contain only
// non-bracket/non-backtick chars or VALID code spans (matching backtick
// counts). A label with an unbalanced backtick run (e.g. ``small` with 2
// open and 1 close) does NOT match, so the link is left unmasked and the
// code-span scan then swallows up to the next backtick — hiding any
// emphasis in between. This is what makes __issues most__ stay literal
// in doc-28.
const BLOCKSKIP_LINK_RE = /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/y;
const LINK_RE = new RegExp('!?\\[(' + LINK_LABEL_SRC + ')\\]\\([ \\t\\n]*(<(?:\\\\.|[^\\n<>\\\\])+>|[^ \\t\\n\\x00-\\x1f]+|(?=\\)))(?:(?:[ \\t]+(?:\\n[ \\t]*)?|\\n[ \\t]*)("(?:\\\\[\\s\\S]|[^"\\\\])*"|\'(?:\\\\[\\s\\S]|[^\'\\\\])*\'|\\((?:\\\\[\\s\\S]|[^)\\\\])*\\)))?[ \\t\\n]*\\)', 'y');
const REFLINK_RE = new RegExp('!?\\[(' + LINK_LABEL_SRC + ')\\]\\[(' + REF_LABEL_SRC + ')\\]', 'y');
const NOLINK_RE = new RegExp('!?\\[(' + REF_LABEL_SRC + ')\\](?:\\[\\])?', 'y');

// marked's anyPunctuationOutsideCode (used for the mask's first pass):
// a code span keeps its backticks but inner backticks become '+';
// an escape becomes '+'s; a lone backtick run is unchanged.
const ANY_PUNCT_OUTSIDE_CODE_RE = /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu;

function buildMask(src, links) {
  const n = src.length;
  // Pass 1 (marked's anyPunctuationOutsideCode): escapes -> '+', and a
  // code span's INNER backticks -> '+'. This is what lets blockSkip match
  // a link whose label holds a code span with an inner backtick
  // (`` a ` b `` -> `` a + b ``), so the whole link gets masked and any
  // emphasis inside its label stays literal (doc-20/doc-23).
  const tmp = src.replace(ANY_PUNCT_OUTSIDE_CODE_RE, (m, run, esc) => {
    if (esc) return '+'.repeat(m.length);
    if (run) return run + m.slice(run.length, -run.length).replace(/`/g, '+') + run;
    return m;
  });
  // Pass 2 (marked's blockSkip) on tmp: mask whole code spans, links and
  // HTML tags as '[' + a's + ']'. Positions line up with src (tmp has the
  // same length). out starts from tmp so escapes / inner backticks stay
  // neutralised as '+' in the mask.
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = tmp[i];
  let i = 0;
  while (i < n) {
    const c = tmp.charCodeAt(i);
    if (c === 96) { // code span
      // marked's blockSkip code pattern has a (?<!`) lookbehind: a code
      // span can only start at the beginning of a backtick run, never
      // in the middle of one (so ``on` is not a code span in the mask).
      if (i > 0 && tmp.charCodeAt(i - 1) === 96) { i++; continue; }
      CODE_RE.lastIndex = i;
      const m = CODE_RE.exec(tmp);
      if (m) {
        const a = m.index, b = a + m[0].length;
        out[a] = '[';
        for (let j = a + 1; j < b - 1; j++) out[j] = 'a';
        out[b - 1] = ']';
        i = b;
        continue;
      }
      i++;
      continue;
    }
    if (c === 91 || (c === 33 && i + 1 < n && tmp.charCodeAt(i + 1) === 91)) { // [ or ![
      const start = c === 91 ? i : i + 1;
      // Inline link: only mask it when it matches marked's blockSkip
      // link pattern (the label must be flat and its code spans valid).
      // An unbalanced backtick in the label breaks the pattern, so the
      // link stays unmasked and the code scan swallows to the next
      // backtick (doc-28).
      BLOCKSKIP_LINK_RE.lastIndex = start;
      const lm = BLOCKSKIP_LINK_RE.exec(tmp);
      if (lm) {
        const end = start + lm[0].length;
        out[start] = '[';
        for (let t = start + 1; t < end - 1; t++) out[t] = 'a';
        out[end - 1] = ']';
        i = end;
        continue;
      }
      // Reflink / shortcut: mask only when the label exists in links
      // (marked's reflinkSearch step).
      const j = findLabelEndFlat(tmp, start);
      if (j > start) {
        let end = -1;
        if (j + 1 < n && tmp.charCodeAt(j + 1) === 91) { // [ref]
          const k = tmp.indexOf(']', j + 2);
          if (k > j + 1) {
            const ref = normLabel(tmp.slice(j + 2, k));
            if (ref === '' ? links.has(normLabel(tmp.slice(start + 1, j))) : links.has(ref)) end = k + 1;
          }
        } else if (links.has(normLabel(tmp.slice(start + 1, j)))) {
          end = j + 1;
        }
        if (end > start) {
          out[start] = '[';
          for (let t = start + 1; t < end - 1; t++) out[t] = 'a';
          out[end - 1] = ']';
          i = end;
          continue;
        }
      }
      i++;
      continue;
    }
    if (c === 60) { // < : html tag or autolink
      TAG_RE.lastIndex = i;
      let m = TAG_RE.exec(tmp);
      if (!m) { AUTOLINK_RE.lastIndex = i; m = AUTOLINK_RE.exec(tmp); }
      if (m) {
        const a = m.index, b = a + m[0].length;
        out[a] = '[';
        for (let j = a + 1; j < b - 1; j++) out[j] = 'a';
        out[b - 1] = ']';
        i = b;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  return out.join('');
}
// Find the index of the ']' closing the label that starts at openIdx, for
// the mask: the label must contain no unescaped '[' (except inside a code
// span), mirroring marked's blockSkip link pattern. -1 if none.
function findLabelEndFlat(src, openIdx) {
  const n = src.length;
  for (let i = openIdx + 1; i < n; i++) {
    const c = src.charCodeAt(i);
    if (c === 92) { i++; continue; }
    if (c === 96) {
      CODE_RE.lastIndex = i;
      const m = CODE_RE.exec(src);
      if (m) { i += m[0].length - 1; continue; }
      continue;
    }
    if (c === 91) return -1;
    if (c === 93) return i;
  }
  return -1;
}
// Find the index of the ']' closing the label that starts at openIdx (the
// '['). Respects escapes, nested brackets and code spans; -1 if none.
function findLabelEnd(src, openIdx) {
  const n = src.length;
  let depth = 0;
  for (let i = openIdx; i < n; i++) {
    const c = src.charCodeAt(i);
    if (c === 92) { i++; continue; }
    if (c === 96) {
      CODE_RE.lastIndex = i;
      const m = CODE_RE.exec(src);
      if (m) { i += m[0].length - 1; continue; }
      continue;
    }
    if (c === 91) depth++;
    else if (c === 93) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}
// Find the index of the ')' closing the paren group that starts at openIdx
// (the '('). Respects escapes and nested parens; -1 if none.
function findParenEnd(src, openIdx) {
  const n = src.length;
  let depth = 0;
  for (let i = openIdx; i < n; i++) {
    const c = src.charCodeAt(i);
    if (c === 92) { i++; continue; }
    if (c === 40) depth++;
    else if (c === 41) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}
// Scan limits (marked's fe): for the masked text, the last run start of
// each delimiter whose preceding char is not whitespace. A run at position 0
// counts its preceding char as "\n" and is never recorded.
function scanLimits(masked) {
  let star = -1, und = -1, del = -1;
  const n = masked.length;
  for (let s = 0; s < n; s++) {
    const r = masked[s];
    if (r !== '*' && r !== '_' && r !== '~') continue;
    const prev = s === 0 ? '\n' : masked[s - 1];
    let i = s + 1;
    while (i < n && masked[i] === r) i++;
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      if (r === '~') del = s;
      else if (r === '*') star = s;
      else und = s;
    }
    s = i - 1;
  }
  return { star, und, del };
}
function codePointBefore(s, i) {
  if (i <= 0) return '';
  const c = s.charCodeAt(i - 1);
  if (c >= 0xDC00 && c <= 0xDFFF && i >= 2) {
    const h = s.charCodeAt(i - 2);
    if (h >= 0xD800 && h <= 0xDBFF) return s.slice(i - 2, i);
  }
  return s[i - 1];
}
// Forward-scan emphasis/strong (marked's emStrong). Returns
// { html, end } or null. run = { src, masked, limits }.
function emStrong(run, pos, prevChar, st) {
  EM_STRONG_LDELIM.lastIndex = pos;
  const s = EM_STRONG_LDELIM.exec(run.src);
  if (!s || (!s[1] && !s[2] && !s[3] && !s[4])) return null;
  const r = s[0][0];
  let n = prevChar;
  const o = n === r;
  const i = pos;
  const masked = run.masked;
  let l = i;
  for (; l > 0 && masked[l - 1] === r;) l--;
  const p = codePointBefore(masked, l);
  const h = p === '*' || p === '_' || isPunctOrSpace(p);
  if (l < i) n = p;
  const u = l < i ? h : isPunctOrSpace(n);
  if (s[4] && isAlnumUni(n)) return null;
  const d = s[1] || s[3] || '';
  if (!d || !n || u) {
    const k = [...s[0]].length - 1;
    let x = k, f = 0;
    const y = i - l + k;
    const R = p.trim() !== '' && (!!d || (r === '*' && !h));
    if (r !== '*' && r !== '_') return null;
    const E = r === '*' ? RDELIM_AST : RDELIM_UND;
    const Z = r === '*' ? run.limits.star : run.limits.und;
    const U = pos + k;
    if (Z < U) return null;
    const t = masked.slice(pos + k);
    const ee = Z - U;
    E.lastIndex = 0;
    let m;
    while ((m = E.exec(t)) !== null && !(m.index > ee)) {
      const g = m[1] || m[2] || m[3] || m[4] || m[5] || m[6];
      if (!g) continue;
      const b = [...g].length;
      if (m[3] || m[4]) { x += b; continue; }
      if (m[5] || m[6] || R) {
        if (o && (m[5] || m[6])) break;
        if (y % 3 && (y + b) % 3 === 0) { f += b; continue; }
      }
      x -= b;
      if (x > 0) continue;
      const bb = Math.min(b, b + x + f);
      const te = [...m[0]][0].length;
      const M = run.src.slice(pos, pos + k + m.index + te + bb);
      if (Math.min(k, bb) % 2) {
        const W = M.slice(1, -1);
        const inner = inlineRun(W, st);
        return { html: st.mode === 'text' ? inner : '<em>' + inner + '</em>', end: pos + M.length };
      }
      const ne = M.slice(2, -2);
      const inner2 = inlineRun(ne, st);
      return { html: st.mode === 'text' ? inner2 : '<strong>' + inner2 + '</strong>', end: pos + M.length };
    }
  }
  return null;
}
// Strikethrough (same shape as emStrong, no rule of three).
function delRun(run, pos, prevChar, st) {
  DEL_LDELIM.lastIndex = pos;
  const s = DEL_LDELIM.exec(run.src);
  if (!s) return null;
  if (!(s[1] || '') || !prevChar || isPunctOrSpace(prevChar)) {
    const o = [...s[0]].length - 1;
    let p = o;
    const u = run.limits.del;
    const d = pos + o;
    if (u < d) return null;
    const t = run.masked.slice(pos + o);
    const k = u - d;
    DEL_RDELIM.lastIndex = 0;
    let m;
    while ((m = DEL_RDELIM.exec(t)) !== null && !(m.index > k)) {
      const g = m[1] || m[2] || m[3] || m[4] || m[5] || m[6];
      if (!g) continue;
      const l = [...g].length;
      if (l !== o) continue;
      if (m[3] || m[4]) { p += l; continue; }
      p -= l;
      if (p > 0) continue;
      const ll = Math.min(l, l + p);
      const te = [...m[0]][0].length;
      const b = run.src.slice(pos, pos + o + m.index + te + ll);
      const x = b.slice(o, -o);
      const inner = inlineRun(x, st);
      return { html: st.mode === 'text' ? inner : '<del>' + inner + '</del>', end: pos + b.length };
    }
  }
  return null;
}

// ---- paren balance (marked's fe): -1 none/balanced, -2 unclosed '(', else
// the index of the extra ')'.
function parenBalance(s) {
  if (s.indexOf('(') === -1 && s.indexOf(')') === -1) return -1;
  let t = 0;
  for (let n = 0; n < s.length; n++) {
    if (s[n] === '\\') n++;
    else if (s[n] === '(') t++;
    else if (s[n] === ')' && (t--, t < 0)) return n;
  }
  return t > 0 ? -2 : -1;
}
// Link text contains an unclosed '<' whose tag/autolink runs past the label.
function hasUnclosedLt(remaining, label, labelStart) {
  if (!label.includes('<')) return false;
  for (let s = 0; s < label.length; s++) {
    if (label[s] === '\\') { s++; continue; }
    if (label[s] === '`') {
      CODE_RE.lastIndex = 0;
      const m = CODE_RE.exec(label.slice(s));
      if (m) { s += m[0].length - 1; continue; }
    }
    if (label[s] !== '<') continue;
    const r = remaining.slice(labelStart + s);
    TAG_RE.lastIndex = 0;
    let o = TAG_RE.exec(r);
    if (!o) { AUTOLINK_RE.lastIndex = 0; o = AUTOLINK_RE.exec(r); }
    if (o) {
      if (o[0].length > label.length - s) return true;
      s += o[0].length - 1;
    }
  }
  return false;
}
// Build a link/image from its parts (marked's Be). Returns the HTML (or the
// plain text in text mode), or null when a nested link kills the outer link.
function buildLink(labelText, href, title, isImage, st) {
  const inLink0 = st.inLink, raw0 = st.inRawBlock, emitted0 = st.linkEmitted;
  st.inLink = true;
  st.linkEmitted = false;
  const inner = inlineRun(labelText, st);
  const nested = st.linkEmitted;
  st.linkEmitted = emitted0;
  st.inLink = inLink0;
  if (!isImage) {
    if (nested) {
      st.inRawBlock = raw0;
      return null;
    }
    st.linkEmitted = true;
    if (st.mode === 'text') return inner;
  } else if (st.mode === 'text') {
    return inner;
  }
  if (isImage) {
    // Alt text: re-parse the label in text mode, starting from the same
    // initial state as the HTML parse, then restore the state.
    const savedMode = st.mode;
    const savedParen = st.linkParenPossible;
    const rawAfterLabel = st.inRawBlock;
    st.mode = 'text';
    st.inLink = true;
    st.inRawBlock = raw0;
    st.linkEmitted = false;
    const alt = inlineRun(labelText, st);
    st.mode = savedMode;
    st.inLink = inLink0;
    st.inRawBlock = rawAfterLabel;
    st.linkEmitted = emitted0;
    st.linkParenPossible = savedParen;
    const h = encodeHref(href);
    if (h === null) return esc(alt, false);
    let out = '<img src="' + esc(h, false) + '" alt="' + esc(alt, false) + '"';
    if (title) out += ' title="' + esc(title, false) + '"';
    return out + '>';
  }
  const h = encodeHref(href);
  if (h === null) return inner;
  let out = '<a href="' + esc(h, false) + '"';
  if (title) out += ' title="' + esc(title, false) + '"';
  return out + '>' + inner + '</a>';
}
function tryLink(run, pos, st) {
  if (!st.linkParenPossible) return null;
  LINK_RE.lastIndex = pos;
  const t = LINK_RE.exec(run.src);
  if (!t) return null;
  const isImage = t[0].charAt(0) === '!';
  const labelStart = isImage ? 2 : 1;
  if (hasUnclosedLt(run.src.slice(pos), t[1], labelStart)) return null;
  let href = t[2];
  let title = '';
  let matchEnd = pos + t[0].length;
  let truncated = false;
  const s = t[2].trim();
  if (s.charCodeAt(0) === 60) { // starts with '<'
    if (!s.endsWith('>')) return null;
    const stripped = stripTrailing(s.slice(0, -1), '\\');
    if ((s.length - stripped.length) % 2 === 0) return null;
  } else {
    const l = parenBalance(t[2]);
    if (l === -2) return null;
    if (l > -1) {
      const h = (isImage ? 5 : 4) + t[1].length + l;
      href = t[2].substring(0, l);
      matchEnd = pos + run.src.slice(pos, pos + h).trimEnd().length;
      truncated = true;
    }
  }
  const rawMatch = run.src.slice(pos, matchEnd);
  const strippedMatch = stripTrailing(rawMatch.slice(0, -1), '\\');
  if ((rawMatch.length - strippedMatch.length) % 2 === 0) return null;
  if (!truncated && t[3]) title = t[3].slice(1, -1);
  href = href.trim();
  if (href.charCodeAt(0) === 60) href = href.slice(1, -1);
  href = href ? href.replace(ANY_PUNCT_RE, '$1') : href;
  title = title ? title.replace(ANY_PUNCT_RE, '$1') : title;
  const labelText = t[1].replace(/\\([\[\]])/g, '$1');
  const html = buildLink(labelText, href, title, isImage, st);
  if (html === null) return null;
  return { html, end: matchEnd };
}
function tryReflink(run, pos, st) {
  REFLINK_RE.lastIndex = pos;
  let n = REFLINK_RE.exec(run.src);
  if (!n) {
    NOLINK_RE.lastIndex = pos;
    n = NOLINK_RE.exec(run.src);
  }
  if (!n) return null;
  const isImage = n[0].charAt(0) === '!';
  const labelStart = isImage ? 2 : 1;
  if (hasUnclosedLt(run.src.slice(pos), n[1], labelStart)) return null;
  const ref = st.links.get(normLabel(n[2] || n[1]));
  if (!ref) {
    const ch = n[0].charAt(0);
    return { html: esc(ch, false), end: pos + 1, textToken: true };
  }
  const labelText = n[1].replace(/\\([\[\]])/g, '$1');
  const html = buildLink(labelText, ref.href, ref.title || '', isImage, st);
  if (html === null) return null;
  return { html, end: pos + n[0].length };
}
function tryCodespan(run, pos, st) {
  CODE_RE.lastIndex = pos;
  const t = CODE_RE.exec(run.src);
  if (!t) return null;
  let text = t[2].replace(/\n/g, ' ');
  const hasNonSpace = /[^ ]/.test(text);
  const startsEndsSpace = text.startsWith(' ') && text.endsWith(' ');
  if (hasNonSpace && startsEndsSpace) text = text.substring(1, text.length - 1);
  return { html: st.mode === 'text' ? text : '<code>' + esc(text, true) + '</code>', end: pos + t[0].length };
}
function tryBr(run, pos, st) {
  BR_RE.lastIndex = pos;
  const t = BR_RE.exec(run.src);
  if (!t) return null;
  return { html: st.mode === 'text' ? '' : '<br>', end: pos + t[0].length };
}
function tryAutolink(run, pos, st) {
  AUTOLINK_RE.lastIndex = pos;
  const t = AUTOLINK_RE.exec(run.src);
  if (!t) return null;
  const text = t[1];
  if (st.mode === 'text') return { html: text, end: pos + t[0].length };
  const href = t[2] === '@' ? 'mailto:' + text : text;
  const h = encodeHref(href);
  if (h === null) return { html: esc(text, true), end: pos + t[0].length };
  return { html: '<a href="' + esc(h, true) + '">' + esc(text, true) + '</a>', end: pos + t[0].length };
}
function tryUrl(run, pos, st) {
  URL_RE.lastIndex = pos;
  const t = URL_RE.exec(run.src);
  if (!t) return null;
  let text, href;
  if (t[2] === '@') {
    text = t[0];
    href = 'mailto:' + text;
  } else {
    let m = t[0];
    let prev;
    do {
      prev = m;
      const b = BACKPEDAL_RE.exec(m);
      m = b ? b[0] : '';
    } while (m !== prev);
    text = m;
    href = t[1] === 'www.' ? 'http://' + m : m;
  }
  if (st.mode === 'text') return { html: text, end: pos + text.length };
  const h = encodeHref(href);
  if (h === null) return { html: esc(text, true), end: pos + text.length };
  return { html: '<a href="' + esc(h, true) + '">' + esc(text, true) + '</a>', end: pos + text.length };
}
function tryTag(run, pos, st) {
  TAG_RE.lastIndex = pos;
  const t = TAG_RE.exec(run.src);
  if (!t) return null;
  const raw = t[0];
  if (!st.inLink && START_A_TAG.test(raw)) st.inLink = true;
  else if (st.inLink && END_A_TAG.test(raw)) st.inLink = false;
  if (!st.inRawBlock && START_PRE_TAG.test(raw)) st.inRawBlock = true;
  else if (st.inRawBlock && END_PRE_TAG.test(raw)) st.inRawBlock = false;
  return { html: raw, end: pos + raw.length };
}
function tryEscape(run, pos, st) {
  ESCAPE_RE.lastIndex = pos;
  const t = ESCAPE_RE.exec(run.src);
  if (!t) return null;
  const ch = t[1];
  return { html: st.mode === 'text' ? ch : esc(ch, false), end: pos + t[0].length, textToken: true, rawText: ch };
}
// Case-insensitive scheme check at i, where src[i] is 'h'/'H' or 'f'/'F':
// 'http://' | 'https://' | 'ftp://'. charCodeAt past the end is NaN,
// which never equals a wanted code, so no bounds checks are needed.
// (The | 32 trick lowercases ASCII letters; only the letter itself and
// its uppercase map onto t/p/s.)
function schemeAt(src, i, c) {
  if (c === 104 || c === 72) { // h/H: http:// or https://
    if ((src.charCodeAt(i + 1) | 32) !== 116) return false; // t
    if ((src.charCodeAt(i + 2) | 32) !== 116) return false; // t
    if ((src.charCodeAt(i + 3) | 32) !== 112) return false; // p
    let j = i + 4;
    if ((src.charCodeAt(j) | 32) === 115) j++; // optional s
    return src.charCodeAt(j) === 58 && src.charCodeAt(j + 1) === 47 && src.charCodeAt(j + 2) === 47;
  }
  // f/F: ftp://
  if ((src.charCodeAt(i + 1) | 32) !== 116) return false; // t
  if ((src.charCodeAt(i + 2) | 32) !== 112) return false; // p
  return src.charCodeAt(i + 3) === 58 && src.charCodeAt(i + 4) === 47 && src.charCodeAt(i + 5) === 47;
}
// End index (exclusive) of the plain-text run starting at pos.
function scanTextEnd(run, pos) {
  const src = run.src, end = src.length;
  let i = pos;
  let firstEnd;
  if (i < end) {
    const c = src.charCodeAt(i);
    if (c === 96) { while (i < end && src.charCodeAt(i) === 96) i++; }
    else if (c === 126) { while (i < end && src.charCodeAt(i) === 126) i++; }
    else {
      if (i + 1 < end && !(c < 128 && IS_ALNUM[c]) && (src.startsWith('mailto:', i + 1) || src.startsWith('xmpp:', i + 1))) return i + 1;
      i++;
    }
  }
  firstEnd = i;
  while (i < end) {
    const c = src.charCodeAt(i);
    if (c === 92 || c === 60 || c === 91 || c === 96 || c === 42 || c === 126 || c === 95 || c === 33) break;
    if (c === 32) {
      let j = i;
      while (j < end && src.charCodeAt(j) === 32) j++;
      if (j - i >= 2 && j < end && src.charCodeAt(j) === 10) break;
      i = j;
      continue;
    }
    if (c === 64) {
      let k = i - 1;
      while (k >= pos && src.charCodeAt(k) < 128 && IS_EMAIL_LOCAL[src.charCodeAt(k)]) k--;
      const localStart = k + 1;
      if (localStart < i && localStart > pos) return Math.max(localStart - 1, firstEnd);
      i++;
      continue;
    }
    if ((c === 104 || c === 72 || c === 102 || c === 70) && schemeAt(src, i, c)) break;
    if (c === 119 && src.startsWith('www.', i)) {
      if (i === pos) break;
      const prev = src.charCodeAt(i - 1);
      if (prev === 32 || prev === 9 || prev === 10 || prev === 13 || prev === 42 || prev === 95 || prev === 126 || prev === 40) break;
    }
    if (!(c < 128 && IS_ALNUM[c]) && (src.startsWith('mailto:', i + 1) || src.startsWith('xmpp:', i + 1))) break;
    i++;
  }
  return i;
}

// Main inline loop (marked's Lexer#t, direct rendering, position-indexed).
function inlineRun(src, st) {
  const savedParen = st.linkParenPossible;
  st.linkParenPossible = savedParen && src.includes(')');
  st.inRawBlock = false;
  const run = { src, masked: src, limits: { star: -1, und: -1, del: -1 } };
  if (src.includes('*') || src.includes('_') || src.includes('~')) {
    run.masked = buildMask(src, st.links);
    run.limits = scanLimits(run.masked);
  }
  const textMode = st.mode === 'text';
  let out = '';
  let pos = 0;
  const n = src.length;
  let prevChar = '';
  let prevWasText = false;
  while (pos < n) {
    if (!prevWasText) prevChar = '';
    prevWasText = false;
    const c = src.charCodeAt(pos);
    let res = null;
    if (c === 92) {
      res = tryEscape(run, pos, st);
      if (!res) res = tryBr(run, pos, st);
    } else if (c === 60) {
      res = tryTag(run, pos, st);
      if (!res) res = tryAutolink(run, pos, st);
    } else if (c === 91 || (c === 33 && pos + 1 < n && src.charCodeAt(pos + 1) === 91)) {
      res = tryLink(run, pos, st);
      if (!res) res = tryReflink(run, pos, st);
    } else if (c === 42 || c === 95) {
      res = emStrong(run, pos, prevChar, st);
    } else if (c === 96) {
      res = tryCodespan(run, pos, st);
    } else if (c === 126) {
      res = delRun(run, pos, prevChar, st);
    } else if (c === 32) {
      res = tryBr(run, pos, st);
    }
    if (!res && !st.inLink && ((c < 128 && IS_ALNUM[c]) || c === 43 || c === 46 || c === 45 || c === 95)) {
      res = tryUrl(run, pos, st);
    }
    if (res) {
      out += res.html;
      if (res.textToken) {
        const rt = res.rawText !== undefined ? res.rawText : res.html;
        if (!rt.endsWith('_')) prevChar = rt[rt.length - 1];
        prevWasText = true;
      }
      pos = res.end;
      continue;
    }
    const end = scanTextEnd(run, pos);
    const raw = src.slice(pos, end);
    if (textMode) {
      out += st.inRawBlock ? raw : decodeEntities(raw);
    } else if (st.inRawBlock) {
      out += raw;
    } else {
      out += esc(decodeEntities(raw), false);
    }
    if (!raw.endsWith('_')) prevChar = raw[raw.length - 1];
    prevWasText = true;
    pos = end;
  }
  st.linkParenPossible = savedParen;
  return out;
}

// ============================= BLOCK =============================
// Line-oriented block lexer. The source is split into lines once; every
// block is a range of lines. Inline parsing happens in the render pass, so
// link reference definitions anywhere in the document are visible to all
// inline runs (first definition wins).

function lineIndentCols(line) {
  let cols = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c === 32) cols++;
    else if (c === 9) cols += 4 - (cols % 4);
    else break;
  }
  return cols;
}
function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}
function fenceStart(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) === 32) i++;
  if (i > 3 || i >= line.length) return null;
  const ch = line[i];
  if (ch !== '`' && ch !== '~') return null;
  let j = i;
  while (j < line.length && line[j] === ch) j++;
  if (j - i < 3) return null;
  const info = line.slice(j);
  if (ch === '`' && info.includes('`')) return null;
  return { ch, len: j - i, info, indent: i };
}
function fenceEnd(line, ch, len) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) === 32) i++;
  if (i > 3) return false;
  let j = i;
  while (j < line.length && line[j] === ch) j++;
  if (j - i < len) return false;
  for (let k = j; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}
function atxHeading(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) === 32) i++;
  if (i > 3 || i >= line.length || line.charCodeAt(i) !== 35) return null;
  let j = i;
  while (j < line.length && line.charCodeAt(j) === 35) j++;
  const depth = j - i;
  if (depth > 6) return null;
  if (j < line.length) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return null;
  }
  let text = line.slice(j).trim();
  // Trailing # run is dropped only when the whole text is #'s, or the run
  // is preceded by a space/tab.
  if (text.length > 0) {
    let k = text.length;
    while (k > 0 && text.charCodeAt(k - 1) === 35) k--;
    if (k < text.length) {
      if (k === 0) text = '';
      else {
        const before = text.charCodeAt(k - 1);
        if (before === 32 || before === 9) text = text.slice(0, k).trimEnd();
      }
    }
  }
  return { depth, text };
}
function isHr(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) === 32) i++;
  if (i > 3 || i >= line.length) return false;
  const ch = line.charCodeAt(i);
  if (ch !== 45 && ch !== 95 && ch !== 42) return false;
  let count = 0;
  for (let j = i; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c === ch) count++;
    else if (c === 32 || c === 9) continue;
    else return false;
  }
  return count >= 3;
}
function isSetextUnderline(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) === 32) i++;
  if (i > 3 || i >= line.length) return null;
  const ch = line.charCodeAt(i);
  if (ch !== 61 && ch !== 45) return null;
  let j = i;
  while (j < line.length && line.charCodeAt(j) === ch) j++;
  for (let k = j; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return null;
  }
  return ch === 61 ? 1 : 2;
}
// List marker at the start of a line (0-3 spaces indent). Returns null or
// { marker, ordered, start, markerEnd, indent }.
function listMarker(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) === 32) i++;
  if (i > 3 || i >= line.length) return null;
  const c = line.charCodeAt(i);
  if (c === 42 || c === 43 || c === 45) {
    if (i + 1 < line.length) {
      const nc = line.charCodeAt(i + 1);
      if (nc !== 32 && nc !== 9) return null;
    }
    return { marker: line[i], ordered: false, start: 0, markerEnd: i + 1, indent: i };
  }
  if (c >= 48 && c <= 57) {
    let j = i;
    while (j < line.length && line.charCodeAt(j) >= 48 && line.charCodeAt(j) <= 57) j++;
    if (j - i > 9 || j >= line.length) return null;
    const d = line.charCodeAt(j);
    if (d !== 46 && d !== 41) return null;
    if (j + 1 < line.length) {
      const nc = line.charCodeAt(j + 1);
      if (nc !== 32 && nc !== 9) return null;
    }
    return { marker: line.slice(i, j + 1), ordered: true, start: parseInt(line.slice(i, j), 10), delim: line[j], markerEnd: j + 1, indent: i };
  }
  return null;
}
function isBlockquoteStart(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) === 32) i++;
  return i <= 3 && i < line.length && line.charCodeAt(i) === 62;
}
// HTML block start type (1-7) or 0. Mirrors the block html regex's seven
// alternatives; type 7 may not interrupt a paragraph.
function htmlBlockType(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) === 32) i++;
  if (i > 3 || i >= line.length || line.charCodeAt(i) !== 60) return 0;
  const rest = line.slice(i);
  const m1 = /^(script|pre|style|textarea)([\s>]|$)/i.exec(rest.slice(1));
  if (m1) return 1;
  if (rest.startsWith('<!--')) return 2;
  if (rest.startsWith('<?')) return 3;
  if (/^<![A-Z]/.test(rest)) return 4;
  if (rest.startsWith('<![CDATA[')) return 5;
  const m6 = /^<\/?([a-zA-Z][a-zA-Z0-9-]*)(?:[ \t]+|\n|\/?>|$)/i.exec(rest);
  if (m6 && BLOCK_TAGS.has(m6[1].toLowerCase())) return 6;
  // Type 7: a complete open tag or closing tag alone on the line. Any tag
  // name counts (inline tags included); only pre/script/style/textarea
  // are excluded (they are type 1).
  const m7 = /^<([A-Za-z][A-Za-z0-9-]*)((?: +[A-Za-z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?)*) *\/?>[ \t]*$/.exec(rest);
  if (m7) {
    const tag = m7[1].toLowerCase();
    if (tag !== 'script' && tag !== 'pre' && tag !== 'style' && tag !== 'textarea') return 7;
  }
  if (/^<\/[A-Za-z][A-Za-z0-9-]*\s*>[ \t]*$/.test(rest)) return 7;
  return 0;
}
const INLINE_TAGS = new Set('a em strong small s cite q dfn abbr data time code var samp kbd sub sup i b u mark ruby rt rp bdi bdo span br wbr ins del img'.split(' '));
const BLOCK_TAGS = new Set('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem meta nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul'.split(' '));
// Table delimiter row: returns the cell strings or null.
const TABLE_DELIM_RE = /^ {0,3}((?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?)$/;
function tableDelimiterCells(line) {
  const m = TABLE_DELIM_RE.exec(line);
  if (!m) return null;
  if (!/[:|]/.test(line)) return null;
  const inner = m[1].replace(/^\||\| *$/g, '');
  return inner.split('|');
}
// Split a table row into cells (marked's ge).
function splitTableRow(row, count) {
  let out = '';
  for (let i = 0; i < row.length; i++) {
    if (row[i] === '|') {
      let l = false, p = i;
      for (; --p >= 0 && row[p] === '\\';) l = !l;
      out += l ? '|' : ' |';
    } else out += row[i];
  }
  const cells = out.split(' |');
  if (cells.length > 0 && !cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells[cells.length - 1].trim()) cells.pop();
  if (count !== undefined) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  for (let i = 0; i < cells.length; i++) cells[i] = cells[i].trim().replace(/\\\|/g, '|');
  return cells;
}
function tableAlignOf(cell) {
  if (/^ *-+: *$/.test(cell)) return 'right';
  if (/^ *:-+: *$/.test(cell)) return 'center';
  if (/^ *:-+ *$/.test(cell)) return 'left';
  return null;
}

// ---- block parsers (each returns { node, next } or null; next = line index) ----
function tryFences(lines, i, end) {
  const fs = fenceStart(lines[i]);
  if (!fs) return null;
  const content = [];
  let j = i + 1;
  let closed = false;
  while (j < end) {
    if (fenceEnd(lines[j], fs.ch, fs.len)) { closed = true; break; }
    content.push(lines[j]);
    j++;
  }
  const next = closed ? j + 1 : j;
  // Indent compensation (backtick fences with leading whitespace only).
  let text;
  if (fs.ch === '`' && fs.indent > 0) {
    const s = fs.indent;
    text = content.map((ln) => {
      let k = 0;
      while (k < ln.length && (ln.charCodeAt(k) === 32 || ln.charCodeAt(k) === 9) && k < s) k++;
      return ln.slice(Math.min(k, s));
    });
  } else text = content;
  const body = text.join('\n');
  const lang = fs.info.trim().replace(/\\([\p{P}\p{S}])/gu, '$1');
  return { node: { t: 'code', text: body, lang }, next };
}
function tryIndentedCode(lines, i, end, endsWithNewline) {
  if (lineIndentCols(lines[i]) < 4 || isBlankLine(lines[i])) return null;
  const collected = [];
  let j = i;
  while (j < end) {
    const ln = lines[j];
    if (isBlankLine(ln)) { collected.push(ln); j++; continue; }
    if (lineIndentCols(ln) >= 4) { collected.push(ln); j++; continue; }
    break;
  }
  let raw = collected.join('\n');
  const lastIdx = j - 1;
  if (lastIdx < lines.length - 1 || endsWithNewline) raw += '\n';
  raw = trimTrailingBlanks(raw);
  const text = raw.split('\n').map((ln) => stripIndent(ln, 4)).join('\n');
  return { node: { t: 'code', text, lang: '' }, next: j };
}
function isListInterrupt(line) {
  const m = listMarker(line);
  if (!m) return false;
  if (m.ordered && m.start !== 1) return false;
  return /^[ \t]+[^ \t\n]/.test(line.slice(m.markerEnd));
}
function isTableStart(lines, j, end) {
  if (j + 1 >= end) return false;
  const h = lines[j];
  let k = 0;
  while (k < h.length && h.charCodeAt(k) === 32) k++;
  if (k >= h.length) return false;
  return tableDelimiterCells(lines[j + 1]) !== null;
}
// Paragraph continuation: does lines[j] continue the paragraph started at i?
// endsNL: whether the last line is followed by a newline in the joined
// string. A whitespace-only line is a continuation only when it is the
// last line and not followed by a newline (marked's [ \t]+\n lookahead).
// bq: inside a blockquote, a LAZY line indented 4+ columns is an
// indented code block in its own sub-chunk (it merges into the paragraph
// with its indent stripped), not a paragraph continuation. A proper '>'
// line keeps its indent as paragraph text. lazySet (when given) holds the
// indices of lazy lines; without it, every 4-column line is excluded.
function paraContinues(lines, j, end, endsNL, bq, lazySet) {
  const line = lines[j];
  if (isBlankLine(line)) {
    if (line.length > 0 && j === end - 1 && !endsNL) return true;
    return false;
  }
  if (bq && lineIndentCols(line) >= 4 && (!lazySet || lazySet.has(j))) {
    // A setext underline indented by 4 (to keep it from becoming a
    // heading) is still a paragraph continuation.
    if (isSetextUnderline(stripIndent(line, 4))) return true;
    return false;
  }
  if (isHr(line)) return false;
  if (atxHeading(line)) return false;
  if (isBlockquoteStart(line)) return false;
  if (fenceStart(line)) return false;
  if (isListInterrupt(line)) return false;
  const ht = htmlBlockType(line);
  if (ht >= 1 && ht <= 6) return false;
  if (isTableStart(lines, j, end)) return false;
  return true;
}
// Setext heading check (GFM lheading): the text lines + underline.
function trySetext(lines, i, end) {
  // First line must not be a table delimiter row.
  if (tableDelimiterCells(lines[i]) !== null) return null;
  // Collect candidate text lines (Ve interior rules).
  let j = i;
  const textLines = [];
  while (j < end) {
    const ln = lines[j];
    if (isBlankLine(ln)) return null;
    // The underline itself is checked first: a '---' line is both an hr
    // and a level-2 setext underline, and here it is the underline.
    const depth = isSetextUnderline(ln);
    if (depth) {
      if (textLines.length === 0) return null;
      const text = textLines.join('\n').trim();
      return { node: { t: 'heading', depth, text }, next: j + 1 };
    }
    if (j > i) {
      if (listMarker(ln)) return null;
      if (lineIndentCols(ln) >= 4) return null;
      if (fenceStart(ln)) return null;
      if (isBlockquoteStart(ln)) return null;
      if (atxHeading(ln)) return null;
      if (isHr(ln)) return null;
      const ht = htmlBlockType(ln);
      if (ht >= 1 && ht <= 6) return null;
      if (tableDelimiterCells(ln) !== null) return null;
    }
    textLines.push(ln);
    j++;
  }
  return null;
}
// Link reference definition starting at line i. Returns the line index after
// the definition, or -1. Registers the link unless mergeInto is given (in
// which case the raw is returned for merging into a paragraph/text node).
function tryDef(lines, i, end, st) {
  const joined = lines.slice(i, Math.min(end, i + 32)).join('\n');
  const m = DEF_RE.exec(joined);
  if (!m) return null;
  if (!m[2].startsWith('<') && parenBalance(m[2]) !== -1) return null;
  const raw = stripTrailing(m[0], '\n');
  const linesUsed = raw.split('\n').length;
  const tag = normLabel(m[1]);
  let href = m[2] ? m[2].replace(/^<(.*)>$/, '$1').replace(ANY_PUNCT_RE, '$1') : '';
  const title = m[3] ? m[3].substring(1, m[3].length - 1).replace(ANY_PUNCT_RE, '$1') : undefined;
  return { next: i + linesUsed, tag, href, title, raw };
}
const DEF_LABEL = '(?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\\\n]|\\n(?![ \\t]*\\n))+';
const DEF_TITLE = '"(?:\\\\[\\s\\S]|[^"\\\\])*"|\'(?:\\\\[\\s\\S]|[^\'\\\\\\n]|\\n(?!\\n))*\'|\\((?:\\\\[\\s\\S]|[^)\\\\])*\\)';
const DEF_RE = new RegExp('^ {0,3}\\[(' + DEF_LABEL + ')\\]: *(?:\\n[ \\t]*)?([^<\\s][^\\s]*|<.*?>)(?:(?: +(?:\\n[ \\t]*)?| *\\n[ \\t]*)(' + DEF_TITLE + '))? *(?:\\n+|$)');
function tryTable(lines, i, end) {
  if (i + 1 >= end) return null;
  const header = lines[i];
  let k = 0;
  while (k < header.length && header.charCodeAt(k) === 32) k++;
  if (k >= header.length) return null;
  const delimCells = tableDelimiterCells(lines[i + 1]);
  if (!delimCells) return null;
  const headerCells = splitTableRow(header);
  if (headerCells.length !== delimCells.length) return null;
  const align = delimCells.map(tableAlignOf);
  const rows = [];
  let j = i + 2;
  while (j < end) {
    const ln = lines[j];
    // A table body row ends at a blank line, but marked's table regex
    // only treats a spaces-only line as blank here (a tab-only line is
    // a row of empty cells).
    if (/^ *$/.test(ln)) break;
    if (isHr(ln)) break;
    if (atxHeading(ln)) break;
    if (isBlockquoteStart(ln)) break;
    if (lineIndentCols(ln) >= 4 && ln.trim() !== '') break;
    if (fenceStart(ln)) break;
    if (listMarker(ln)) break;
    if (htmlBlockType(ln) >= 1 && htmlBlockType(ln) <= 6) break;
    rows.push(splitTableRow(ln, headerCells.length));
    j++;
  }
  return {
    node: { t: 'table', header: headerCells, align, rows },
    next: j,
  };
}

function isParagraphLine(ln) {
  if (isBlankLine(ln)) return false;
  if (fenceStart(ln)) return false;
  if (atxHeading(ln)) return false;
  if (isHr(ln)) return false;
  if (isBlockquoteStart(ln)) return false;
  if (listMarker(ln)) return false;
  if (lineIndentCols(ln) >= 4) return false;
  const ht = htmlBlockType(ln);
  if (ht >= 1 && ht <= 6) return false;
  if (tableDelimiterCells(ln) !== null) return false;
  return true;
}
function stripBlockquoteMarker(ln) {
  const expanded = expandLeadingTabs(ln, 0);
  const m = /^ {0,3}>/.exec(expanded);
  if (!m) return null;
  const after = expanded.slice(m[0].length);
  let i = 0;
  while (i < after.length && (after.charCodeAt(i) === 32 || after.charCodeAt(i) === 9)) i++;
  const ws = expandTabs(after.slice(0, i), m[0].length);
  const rest = after.slice(i);
  return (ws.length > 0 ? ws.slice(1) : '') + rest;
}
function tryBlockquote(lines, i, end, st) {
  const content = [];
  // Indices in content that came from lazy lines (no '>' marker): only
  // those are subject to the 4-column indented-code rule in
  // paraContinues; a proper '>' line keeps its indent as paragraph text.
  const lazyIdx = new Set();
  let j = i;
  let prevEmptyMarker = false;
  let prevContentLine = null;
  // Fence state over the stripped content lines: a lazy line inside an
  // open fence does not continue the blockquote (marked ends the chunk
  // when its last token is a code block).
  let fence = null;
  while (j < end) {
    const ln = lines[j];
    if (isBlockquoteStart(ln)) {
      const stripped = stripBlockquoteMarker(ln);
      content.push(stripped);
      prevEmptyMarker = (stripped === '');
      prevContentLine = stripped;
      if (fence) {
        if (fenceEnd(stripped, fence.ch, fence.len)) fence = null;
      } else {
        const fs = fenceStart(stripped);
        if (fs) fence = { ch: fs.ch, len: fs.len };
      }
      j++;
    } else {
      if (isBlankLine(ln)) break;
      if (prevEmptyMarker) break;
      if (fence) break;
      if (prevContentLine === null) break;
      // A lazy line after a nested blockquote line belongs inside the
      // nested blockquote: the previous line, with all its '>' markers
      // stripped, must be a paragraph line, and the lazy line inherits
      // the '>' prefix so it parses inside the nesting.
      const bqPrefix = /^(?: {0,3}>[ \t]?)+/.exec(prevContentLine);
      const innerPrev = bqPrefix ? prevContentLine.slice(bqPrefix[0].length) : prevContentLine;
      // A lazy line after a list item belongs inside the item: it
      // inherits the item's content indent, plus a '>' if the item's
      // content is itself a blockquote.
      let listPrefix = '';
      let innerForPara = innerPrev;
      if (!bqPrefix) {
        const lm = listMarker(prevContentLine);
        if (lm) {
          const after = prevContentLine.slice(lm.markerEnd);
          const x = expandLeadingTabs(after, lm.markerEnd);
          const off = x.search(/[^ ]/);
          const R = off === -1 ? x.length : off;
          const contentIndent = lm.markerEnd + (R > 4 ? 1 : R);
          const content = x.slice(R > 4 ? 1 : R);
          const innerBQ = /^(?: {0,3}>[ \t]?)+/.exec(content);
          listPrefix = ' '.repeat(contentIndent) + (innerBQ ? innerBQ[0] : '');
          innerForPara = innerBQ ? content.slice(innerBQ[0].length) : content;
        }
      }
      if (!isParagraphLine(innerForPara)) break;
      if (!paraContinues(lines, j, end, st.endsWithNewline)) break;
      const depth = isSetextUnderline(ln);
      if (depth) {
        const ind = '    ' + expandLeadingTabs(ln, 0).replace(/^ {0,3}/, '');
        lazyIdx.add(content.length);
        content.push(ind);
        prevContentLine = ind;
      } else {
        // A lazy line is kept as-is: if it is indented 4+ columns it is
        // an indented code block, which merges into the paragraph with
        // its indent stripped (marked's code-into-paragraph merge).
        const pushed = (bqPrefix ? bqPrefix[0] : '') + listPrefix + ln;
        lazyIdx.add(content.length);
        content.push(pushed);
        prevContentLine = pushed;
      }
      j++;
    }
  }
  const inner = parseBlocks(content, true, st, false, true, lazyIdx);
  return { node: { t: 'blockquote', children: inner }, next: j };
}
// List parsing. Returns { node, next } or null.
function tryList(lines, i, end, st) {
  const first = listMarker(lines[i]);
  if (!first) return null;
  if (isHr(lines[i])) return null;
  const ordered = first.ordered;
  const markerChar = ordered ? first.delim : first.marker;
  const startNum = ordered ? first.start : '';
  const items = [];
  let j = i;
  while (j < end) {
    const ln = lines[j];
    const m = listMarker(ln);
    if (!m) break;
    if (m.ordered !== ordered) break;
    if (ordered) { if (m.delim !== markerChar) break; }
    else { if (m.marker !== markerChar) break; }
    if (isHr(ln)) break;
    const b = m.markerEnd;
    const g = ln.slice(b);
    const x = expandLeadingTabs(g, b);
    const y = !x.trim();
    let R, d;
    if (y) { R = b + 1; d = ''; }
    else {
      R = x.search(/[^ ]/);
      if (R === -1) R = x.length;
      if (R > 4) R = 1;
      d = x.slice(R);
      R += b;
    }
    const itemLines = [d];
    j++;
    let itemEmpty = y;
    // marked's x: the previous line's content with R columns stripped,
    // updated every iteration; the lazy-line break checks test it (a
    // fence/heading/hr/html line ends the item at the next lazy line).
    let prev = d;
    // An empty item that eats a following blank line ends there (marked's
    // u flag): the continuation loop is skipped entirely.
    let ateBlank = false;
    if (y && j < end && isBlankLine(lines[j])) { itemEmpty = true; ateBlank = true; j++; }
    while (j < end && !ateBlank) {
      const f = lines[j];
      if (nextBulletAt(f, R)) break;
      if (hrAt(f, R)) break;
      if (fencesBeginAt(f, R)) break;
      if (headingBeginAt(f, R)) break;
      if (htmlBeginAt(f, R)) break;
      if (blockquoteBeginAt(f, R)) break;
      const H = expandLeadingTabs(f, 0);
      const hs = H.search(/[^ ]/);
      if (hs >= R || !f.trim()) {
        // A blank line followed by a line that ends the item (a block
        // start that is not a sibling bullet, or a lazy line) ends the
        // item without consuming the blank line, so the blank line stays
        // visible to the outer level (it makes the outer list loose via
        // a space token). A blank line before a sibling bullet IS
        // consumed: it belongs to this item and makes the list loose via
        // endsWithBlank.
        if (!f.trim() && j + 1 < end) {
          const nx = lines[j + 1];
          if (nx.trim() && !nextBulletAt(nx, R)) {
            const HN = expandLeadingTabs(nx, 0);
            const hsN = HN.search(/[^ ]/);
            if (hsN < R || hrAt(nx, R) || fencesBeginAt(nx, R) || headingBeginAt(nx, R) || htmlBeginAt(nx, R) || blockquoteBeginAt(nx, R)) break;
          }
        }
        itemLines.push(H.slice(R));
        itemEmpty = !f.trim();
        prev = H.slice(R);
        j++;
        continue;
      }
      // Lazy line.
      const firstContentIndent = prev.replace(/\t/g, '    ').search(/[^ ]/);
      if (itemEmpty || firstContentIndent >= 4 || fenceStart(prev) || atxHeading(prev) || isHr(prev) || (htmlBlockType(prev) >= 1 && htmlBlockType(prev) <= 6)) break;
      let Ze = f;
      if (isSetextUnderline(f) && trySetext([prev, f], 0, 2)) Ze = '    ' + expandLeadingTabs(f, 0).replace(/^ {0,3}/, '');
      itemLines.push(Ze);
      itemEmpty = false;
      prev = H.slice(R);
      j++;
    }
    items.push({ lines: itemLines, ateBlank });
  }
  // Strip trailing blank lines from each item (they do not make it loose),
  // but remember whether an item ended with a blank line (a blank line
  // between two items makes the list loose). A lone blank line is an empty
  // item's own content, not a separator, so it does not count — except
  // when the empty item ate a following blank line (that blank line does
  // separate it from the next item).
  for (const it of items) {
    it.endsWithBlank = (it.lines.length > 1 && isBlankLine(it.lines[it.lines.length - 1])) || it.ateBlank;
    while (it.lines.length > 0 && isBlankLine(it.lines[it.lines.length - 1])) it.lines.pop();
  }
  // Loose: a blank line between two items (endsWithBlank). A blank line
  // inside an item is caught by the space-token check below; checking the
  // raw lines would also catch blank lines inside nested lists, which
  // must not make the outer list loose.
  let loose = false;
  for (let k = 0; k < items.length; k++) {
    if (k < items.length - 1 && items[k].endsWithBlank) { loose = true; break; }
  }
  const parsedItems = items.map((it) => {
    // Remove a leading blank line in the item content (from an empty first line).
    const ls = it.lines.slice();
    while (ls.length > 0 && isBlankLine(ls[0])) ls.shift();
    return { tokens: parseBlocks(ls, false, st, false) };
  });
  // Task + loose from tokens: a space token between two block nodes
  // means a blank line between blocks in the item.
  for (const pi of parsedItems) {
    const toks = pi.tokens;
    for (let q = 0; q < toks.length; q++) {
      if (toks[q].t === 'space' && q > 0 && q < toks.length - 1) { loose = true; break; }
    }
    if (loose) break;
  }
  // Task markers.
  for (const pi of parsedItems) {
    const toks = pi.tokens;
    if (toks.length === 0) { pi.task = null; continue; }
    const firstTok = toks[0];
    const firstText = firstTok.t === 'paragraph' ? firstTok.text : firstTok.t === 'text' ? firstTok.text : null;
    if (firstText === null) { pi.task = null; continue; }
    const tm = /^\[[ xX]\][ \t]+\S/.exec(firstText);
    if (!tm) { pi.task = null; continue; }
    pi.task = firstText[1] === ' ' ? false : true;
    // Remove the marker from the first text token.
    const rest = firstText.replace(/^\[[ xX]\][ \t]+/, '');
    firstTok.text = rest;
  }
  return { node: { t: 'list', ordered, start: startNum, loose, items: parsedItems }, next: j };
}
// marked's D() memoizer clamps the indent used by the list break-check
// regexes to min(3, R-1): a bullet at the content indent is a nested list,
// not a sibling, so it must not break the item.
function clampR(R) { return Math.max(0, Math.min(3, R - 1)); }
// Memoised break-check regexes (only 4 possible clamp values each);
// building a RegExp per call was the hottest spot in the profile.
function memoAt(make) {
  const cache = [null, null, null, null];
  return (R) => {
    const k = clampR(R);
    let re = cache[k];
    if (!re) { re = make(k); cache[k] = re; }
    return re;
  };
}
const NEXT_BULLET_AT = memoAt((k) => new RegExp('^ {0,' + k + '}(?:[*+-]|\\d{1,9}[.)])((?:[ \\t][^\\n]*)?(?:\\n|$))'));
const HR_AT = memoAt((k) => new RegExp('^ {0,' + k + '}((?:-[ \\t]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)'));
const FENCES_BEGIN_AT = memoAt((k) => new RegExp('^ {0,' + k + '}(?:```|~~~)'));
const HEADING_BEGIN_AT = memoAt((k) => new RegExp('^ {0,' + k + '}#{1,6}(?:\\s|$)'));
const HTML_BEGIN_AT = memoAt((k) => new RegExp('^ {0,' + k + '}(?:</?(?:' + BLOCK_TAGS + ')(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)', 'i'));
const BLOCKQUOTE_BEGIN_AT = memoAt((k) => new RegExp('^ {0,' + k + '}>'));
function nextBulletAt(line, R) {
  return NEXT_BULLET_AT(R).test(line);
}
function hrAt(line, R) {
  return HR_AT(R).test(line);
}
function fencesBeginAt(line, R) {
  return FENCES_BEGIN_AT(R).test(line);
}
function headingBeginAt(line, R) {
  return HEADING_BEGIN_AT(R).test(line);
}
function htmlBeginAt(line, R) {
  return HTML_BEGIN_AT(R).test(line);
}
function blockquoteBeginAt(line, R) {
  return BLOCKQUOTE_BEGIN_AT(R).test(line);
}

function expandLeadingTabs(line, col) {
  let i = 0;
  while (i < line.length && (line.charCodeAt(i) === 32 || line.charCodeAt(i) === 9)) i++;
  if (i === 0) return line;
  return expandTabs(line.slice(0, i), col) + line.slice(i);
}
function tryHtml(lines, i, end, endsWithNewline) {
  const ln = lines[i];
  if (!/^ {0,3}</.test(ln)) return null;
  const type = htmlBlockType(ln);
  if (type === 0) return null;
  const collected = [ln];
  let j = i + 1;
  const closeReFor = (tag) => new RegExp('</' + tag + '>', 'i');
  if (type === 1) {
    const tag = /<(script|pre|style|textarea)(?:[\s>]|$)/i.exec(ln)[1].toLowerCase();
    const cr = closeReFor(tag);
    if (!cr.test(ln)) {
      while (j < end) {
        collected.push(lines[j]);
        if (cr.test(lines[j])) { j++; break; }
        j++;
      }
    }
  } else if (type === 2) {
    if (ln.indexOf('-->') === -1) {
      while (j < end) {
        collected.push(lines[j]);
        if (lines[j].indexOf('-->') !== -1) { j++; break; }
        j++;
      }
    }
  } else if (type === 3) {
    if (ln.indexOf('?>') === -1) {
      while (j < end) {
        collected.push(lines[j]);
        if (lines[j].indexOf('?>') !== -1) { j++; break; }
        j++;
      }
    }
  } else if (type === 4) {
    if (ln.indexOf('>') === -1) {
      while (j < end) {
        collected.push(lines[j]);
        if (lines[j].indexOf('>') !== -1) { j++; break; }
        j++;
      }
    }
  } else if (type === 5) {
    if (ln.indexOf(']]>') === -1) {
      while (j < end) {
        collected.push(lines[j]);
        if (lines[j].indexOf(']]>') !== -1) { j++; break; }
        j++;
      }
    }
  } else {
    while (j < end && !isBlankLine(lines[j])) { collected.push(lines[j]); j++; }
  }
  let text = collected.join('\n');
  const lastIdx = j - 1;
  const followedByNewline = lastIdx < lines.length - 1 || endsWithNewline;
  // Types 1-5 end at a closing marker: the trailing newline is dropped
  // only when the next line is empty (a tab-only line does not drop it).
  // Types 6-7 run to a blank line, so any blank line drops it.
  const nextLine = j < end ? lines[j] : null;
  const nextIsBlank = nextLine === null ? false : (type <= 5 ? nextLine.length === 0 : isBlankLine(nextLine));
  if (followedByNewline && !nextIsBlank) text += '\n';
  return { node: { t: 'html', text, pre: type === 1 }, next: j };
}
// Main block parser. lines: array of lines (no \n). top: true at document level.
// st: { links: Map } (link reference definitions, first wins).
function parseBlocks(lines, top, st, ewn, bq, lazySet) {
  const endsNL = ewn === undefined ? st.endsWithNewline : ewn;
  const nodes = [];
  let i = 0;
  const end = lines.length;
  const lastNode = () => nodes.length > 0 ? nodes[nodes.length - 1] : null;
  // Whether a blank line was skipped since the last node: a blank line
  // produces a space token in marked, which breaks the code/def merge
  // into a preceding paragraph/text node and the text-node merge.
  let hadBlank = false;
  while (i < end) {
    const ln = lines[i];
    if (isBlankLine(ln)) {
      // A run of blank lines becomes one space token (marked's space
      // token); it breaks the code/def and text merges, and its position
      // (between two block nodes) is what makes a list loose.
      hadBlank = true;
      let cnt = 0;
      while (i < end && isBlankLine(lines[i])) { cnt++; i++; }
      nodes.push({ t: 'space', raw: '\n'.repeat(cnt) });
      continue;
    }
    // Indented code.
    const code = tryIndentedCode(lines, i, end, endsNL);
    if (code) {
      const prev = lastNode();
      if (!hadBlank && prev && (prev.t === 'paragraph' || prev.t === 'text')) {
        prev.text += '\n' + code.node.text;
        i = code.next;
        hadBlank = false;
        continue;
      }
      nodes.push(code.node);
      i = code.next;
      hadBlank = false;
      continue;
    }
    // Fences.
    const fences = tryFences(lines, i, end);
    if (fences) { nodes.push(fences.node); i = fences.next; hadBlank = false; continue; }
    // ATX heading.
    const atx = atxHeading(ln);
    if (atx) { nodes.push({ t: 'heading', depth: atx.depth, text: atx.text }); i++; hadBlank = false; continue; }
    // HR.
    if (isHr(ln)) { nodes.push({ t: 'hr' }); i++; hadBlank = false; continue; }
    // Blockquote.
    if (isBlockquoteStart(ln)) {
      const bq = tryBlockquote(lines, i, end, st);
      nodes.push(bq.node);
      i = bq.next;
      hadBlank = false;
      continue;
    }
    // List.
    if (listMarker(ln)) {
      const lst = tryList(lines, i, end, st);
      if (lst) { nodes.push(lst.node); i = lst.next; hadBlank = false; continue; }
    }
    // HTML block.
    const html = tryHtml(lines, i, end, endsNL);
    if (html) { nodes.push(html.node); i = html.next; hadBlank = false; continue; }
    // Link reference definition.
    const def = tryDef(lines, i, end, st);
    if (def) {
      const prev = lastNode();
      if (!hadBlank && prev && (prev.t === 'paragraph' || prev.t === 'text')) {
        prev.text += '\n' + def.raw;
        i = def.next;
        continue;
      }
      // A def is zero-width: it does not reset hadBlank, so a second def
      // after a blank line still must not merge into the paragraph.
      // It does produce a (zero-width) token, so a space token before it
      // counts as between two blocks for the loose check.
      if (!st.links.has(def.tag)) st.links.set(def.tag, { href: def.href, title: def.title });
      nodes.push({ t: 'def' });
      i = def.next;
      continue;
    }
    // Table.
    const table = tryTable(lines, i, end);
    if (table) { nodes.push(table.node); i = table.next; hadBlank = false; continue; }
    // Setext heading.
    const setext = trySetext(lines, i, end);
    if (setext) { nodes.push(setext.node); i = setext.next; hadBlank = false; continue; }
    // Paragraph (top) / text (!top, one line; consecutive text nodes merge).
    if (top) {
      let j = i + 1;
      while (j < end && paraContinues(lines, j, end, endsNL, bq, lazySet)) j++;
      const text = lines.slice(i, j).join('\n');
      nodes.push({ t: 'paragraph', text });
      i = j;
    } else {
      const prev = lastNode();
      if (!hadBlank && prev && prev.t === 'text') {
        prev.text += '\n' + ln;
        i++;
      } else {
        nodes.push({ t: 'text', text: ln });
        i++;
      }
    }
    hadBlank = false;
  }
  return nodes;
}

// ============================= RENDER =============================
function renderTable(n, st) {
  let out = '<table>\n<thead>\n<tr>\n';
  for (let c = 0; c < n.header.length; c++) {
    const al = n.align[c] ? ' align="' + n.align[c] + '"' : '';
    out += '<th' + al + '>' + inlineRun(n.header[c], st) + '</th>\n';
  }
  out += '</tr>\n</thead>\n';
  if (n.rows.length > 0) {
    out += '<tbody>';
    for (const row of n.rows) {
      out += '<tr>\n';
      for (let c = 0; c < row.length; c++) {
        const al = n.align[c] ? ' align="' + n.align[c] + '"' : '';
        out += '<td' + al + '>' + inlineRun(row[c], st) + '</td>\n';
      }
      out += '</tr>\n';
    }
    out += '</tbody>';
  }
  out += '</table>\n';
  return out;
}
function renderList(n, st) {
  const tag = n.ordered ? 'ol' : 'ul';
  const start = n.ordered && n.start !== 1 ? ' start="' + n.start + '"' : '';
  let out = '<' + tag + start + '>\n';
  for (const item of n.items) {
    const cb = item.task === null ? '' : '<input ' + (item.task ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
    let inner = '';
    if (n.loose) {
      const toks = item.tokens.map((tk) => tk.t === 'text' ? { t: 'paragraph', text: tk.text } : tk);
      inner = renderBlocks(toks, st, cb);
    } else {
      for (let k = 0; k < item.tokens.length; k++) {
        const tk = item.tokens[k];
        const prefix = (k === 0) ? cb : '';
        if (tk.t === 'text' || tk.t === 'paragraph') inner += prefix + inlineRun(tk.text, st);
        else inner += renderBlocks([tk], st, prefix);
      }
    }
    out += '<li>' + inner + '</li>\n';
  }
  out += '</' + tag + '>\n';
  return out;
}
function renderBlocks(nodes, st, cb) {
  let out = '';
  for (let idx = 0; idx < nodes.length; idx++) {
    const n = nodes[idx];
    const prefix = (idx === 0 && cb) ? cb : '';
    switch (n.t) {
      case 'paragraph': out += '<p>' + prefix + inlineRun(n.text, st) + '</p>\n'; break;
      case 'text': out += prefix + inlineRun(n.text, st); break;
      case 'heading': out += '<h' + n.depth + '>' + inlineRun(n.text, st) + '</h' + n.depth + '>\n'; break;
      case 'code': {
        const langWord = n.lang ? (n.lang.match(/^\S*/) || [''])[0] : '';
        const lang = langWord ? ' class="language-' + esc(langWord, false) + '"' : '';
        const r = n.text ? n.text.replace(/\n$/, '') + '\n' : '';
        out += '<pre><code' + lang + '>' + esc(r, true) + '</code></pre>\n';
        break;
      }
      case 'hr': out += '<hr>\n'; break;
      case 'html': out += n.text; break;
      case 'blockquote': out += '<blockquote>\n' + renderBlocks(n.children, st) + '</blockquote>\n'; break;
      case 'table': out += renderTable(n, st); break;
      case 'list': out += renderList(n, st); break;
      case 'space': break;
    }
  }
  return out;
}

// ============================= EXPORT =============================
export function parse(markdown) {
  const src = markdown.replace(/\r\n|\r/g, '\n');
  const endsWithNewline = src.endsWith('\n');
  const lines = src.split('\n');
  if (endsWithNewline) lines.pop();
  const st = {
    links: new Map(),
    inLink: false,
    inRawBlock: false,
    linkEmitted: false,
    linkParenPossible: true,
    mode: 'normal',
    endsWithNewline,
  };
  const nodes = parseBlocks(lines, true, st);
  return renderBlocks(nodes, st);
}
export default parse;
