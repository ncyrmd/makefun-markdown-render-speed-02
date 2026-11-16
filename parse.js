// A fast CommonMark 0.31.2 + GFM 0.29 parser, written from scratch to match
// the HTML marked 18.1.3 renders with its default options (gfm on, breaks
// off, pedantic off, async off), byte for byte. No dependencies, no network,
// no caching across calls: every parse() computes its input alone.
//
// Layout: small helpers, a tab-aware line cursor, the block parser (which
// builds a tree and collects link reference definitions), the renderer, and
// the inline parser (single pass with a delimiter stack, CommonMark emphasis
// and link rules, plus GFM tables, strikethrough, task lists and the extended
// autolinks). Where marked departs from the spec, marked's output wins.

/**
 * Document-level "inside a link" flag, mirroring marked's Lexer state:
 * an inline `<a ...>` tag (matching /^<a /i — note: "<a>" with no space
 * does NOT count) sets it, a `</a>` tag clears it, and it is NEVER reset
 * between blocks — so a self-closing `<a  />` with no closing tag
 * suppresses every later GFM extended autolink (www./scheme/email) in the
 * document. Angle autolinks <...> are not gated by it. Reset at the start
 * of each parse(); parse() is never re-entrant.
 */
let inLinkDoc = false;

/** True for an ASCII whitespace character (space, tab, newline, CR, FF, VT). */
function isSpace(c) {
  return c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 11;
}

/** True for an ASCII punctuation character. */
function isPunct(c) {
  return (c >= 33 && c <= 47) || (c >= 58 && c <= 64) || (c >= 91 && c <= 96) || (c >= 123 && c <= 126);
}

/** True for an ASCII letter or digit. */
function isAlnum(c) {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

/** True for a word character in an entity name: ASCII letter, digit or _. */
function isWordChar(c) {
  return isAlnum(c) || c === 95;
}

const UNI_WS = /\p{White_Space}/u;
const UNI_PUNCT = /[\p{P}\p{S}]/u;
/**
 * Unicode whitespace, for emphasis flanking only (blank lines and
 * indentation stay ASCII). NBSP and other Unicode spaces count here.
 */
function isUniSpace(c) {
  if (c < 128) return isSpace(c);
  return UNI_WS.test(String.fromCharCode(c));
}
/**
 * Unicode punctuation, for emphasis flanking only: ASCII punctuation plus
 * Unicode general categories P (punctuation) and S (symbols, e.g. $ £ €).
 */
function isUniPunct(c) {
  if (c < 128) return isPunct(c);
  return UNI_PUNCT.test(String.fromCharCode(c));
}

/**
 * Length of the entity reference starting at `&` in s at i, or 0 when the
 * `&` starts none. A named reference is `&` + word characters + `;` (the
 * name is never validated: any word-shaped reference passes through).
 * A numeric reference is `&#` + 1-7 decimal digits + `;`, or `&#x`/`&#X` +
 * 1-6 hex digits + `;`. Anything longer is not a reference at all.
 */
function entityLen(s, i) {
  const n = s.length;
  let j = i + 1;
  if (j >= n) return 0;
  const c = s.charCodeAt(j);
  if (c === 35) {
    // &#...
    j++;
    if (j < n && (s.charCodeAt(j) === 120 || s.charCodeAt(j) === 88)) {
      // &#x... / &#X...
      j++;
      const start = j;
      while (j < n) {
        const h = s.charCodeAt(j);
        if ((h >= 48 && h <= 57) || (h >= 65 && h <= 70) || (h >= 97 && h <= 102)) j++;
        else break;
      }
      const digits = j - start;
      if (digits >= 1 && digits <= 6 && j < n && s.charCodeAt(j) === 59) return j + 1 - i;
      return 0;
    }
    const start = j;
    while (j < n && s.charCodeAt(j) >= 48 && s.charCodeAt(j) <= 57) j++;
    const digits = j - start;
    if (digits >= 1 && digits <= 7 && j < n && s.charCodeAt(j) === 59) return j + 1 - i;
    return 0;
  }
  let k = j;
  while (k < n && isWordChar(s.charCodeAt(k))) k++;
  if (k > j && k < n && s.charCodeAt(k) === 59) return k + 1 - i;
  return 0;
}

/**
 * Decode a numeric character reference starting at `&` in s at i.
 * Returns [character, length] or null when it is not a numeric reference.
 * 0, surrogates and values above U+10FFFF become U+FFFD.
 */
function decodeNumeric(s, i) {
  const n = s.length;
  let j = i + 1;
  if (j >= n || s.charCodeAt(j) !== 35) return null;
  j++;
  let hex = false;
  if (j < n && (s.charCodeAt(j) === 120 || s.charCodeAt(j) === 88)) {
    hex = true;
    j++;
  }
  const start = j;
  let value = 0;
  if (hex) {
    while (j < n) {
      const h = s.charCodeAt(j);
      let d = -1;
      if (h >= 48 && h <= 57) d = h - 48;
      else if (h >= 65 && h <= 70) d = h - 55;
      else if (h >= 97 && h <= 102) d = h - 87;
      else break;
      value = value * 16 + d;
      j++;
    }
    const digits = j - start;
    if (digits < 1 || digits > 6 || j >= n || s.charCodeAt(j) !== 59) return null;
  } else {
    while (j < n && s.charCodeAt(j) >= 48 && s.charCodeAt(j) <= 57) {
      value = value * 10 + (s.charCodeAt(j) - 48);
      j++;
    }
    const digits = j - start;
    if (digits < 1 || digits > 7 || j >= n || s.charCodeAt(j) !== 59) return null;
  }
  if (value === 0 || (value >= 0xd800 && value <= 0xdfff) || value > 0x10ffff) {
    return ['\uFFFD', j + 1 - i];
  }
  return [String.fromCodePoint(value), j + 1 - i];
}

/**
 * Escape &, <, >, ", '. A & that starts a named entity is left alone; a
 * numeric character reference (&#...; / &#x...;) is decoded to the
 * character (0, surrogates and values above U+10FFFF become U+FFFD), and
 * the decoded character is escaped again when it is itself special.
 */
function esc(s) {
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let rep = null;
    let skip = 1;
    if (c === 38) {
      const dec = decodeNumeric(s, i);
      if (dec) {
        const ch = dec[0];
        if (ch === '&') rep = '&amp;';
        else if (ch === '<') rep = '&lt;';
        else if (ch === '>') rep = '&gt;';
        else if (ch === '"') rep = '&quot;';
        else if (ch === "'") rep = '&#39;';
        else rep = ch;
        skip = dec[1];
      } else if (entityLen(s, i) === 0) {
        rep = '&amp;';
      }
    } else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    if (rep !== null) {
      if (start < i) out += s.slice(start, i);
      out += rep;
      start = i + skip;
      i += skip - 1;
    }
  }
  if (start === 0) return s;
  if (start < s.length) out += s.slice(start);
  return out;
}

/** Escape &, <, >, ", ' unconditionally (code spans, autolink text/href). */
function escAll(s) {
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let rep = null;
    if (c === 38) rep = '&amp;';
    else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    if (rep !== null) {
      if (start < i) out += s.slice(start, i);
      out += rep;
      start = i + 1;
    }
  }
  if (start === 0) return s;
  if (start < s.length) out += s.slice(start);
  return out;
}

/**
 * encodeURI, except a % is never encoded: a valid escape (%20) stays, and
 * a bare % (98%-) stays too. encodeURI would turn the bare % into %25.
 */
function encodeUrl(url) {
  if (url.indexOf('%') === -1) return encodeURI(url);
  return url.split('%').map((part) => encodeURI(part)).join('%');
}

/**
 * A link destination or autolink URL as marked renders it in href: percent
 * encode it the way encodeURI does, then escape it for the attribute
 * (leaving entity-shaped & sequences alone). Returns null when the URL
 * cannot be encoded (a lone surrogate), in which case no link is formed.
 */
function cleanHref(href) {
  let encoded;
  try {
    encoded = encodeUrl(href);
  } catch {
    return null;
  }
  return esc(encoded);
}

// ---- Tab-aware line cursor -----------------------------------------------
// A view onto one source line. col is the virtual column; a tab that is
// only partly consumed leaves `extra` spaces standing in for its remainder
// (the tab itself is consumed, so rest() never shows it).

function lineOf(s) {
  return { s, i: 0, col: 0, extra: 0 };
}

/** Character code at the cursor (32 while virtual spaces stand), -1 at EOL. */
function cur(l) {
  if (l.extra > 0) return 32;
  return l.i < l.s.length ? l.s.charCodeAt(l.i) : -1;
}

/**
 * Advance up to n columns through spaces and tabs only. Stops at any other
 * character. Returns the columns actually moved.
 */
function adv(l, n) {
  let moved = 0;
  while (moved < n) {
    if (l.extra > 0) {
      const t = Math.min(l.extra, n - moved);
      l.extra -= t;
      l.col += t;
      moved += t;
      continue;
    }
    if (l.i >= l.s.length) break;
    const c = l.s.charCodeAt(l.i);
    if (c === 32) {
      l.i++;
      l.col++;
      moved++;
    } else if (c === 9) {
      const w = 4 - (l.col % 4);
      if (moved + w <= n) {
        l.i++;
        l.col += w;
        moved += w;
      } else {
        l.extra = w - (n - moved);
        l.col += n - moved;
        l.i++;
        moved = n;
      }
    } else break;
  }
  return moved;
}

/** The text from the cursor to end of line (virtual spaces first). */
function rest(l) {
  return (l.extra > 0 ? ' '.repeat(l.extra) : '') + l.s.slice(l.i);
}

/**
 * Remove up to n characters from the line's leading whitespace run.
 * Each virtual space (extra) and each space/tab character counts as 1
 * (marked's fenced-code dedent removes characters, not columns — a tab
 * in the indent counts as one character, so a backtick fence of indent
 * 2 drops a leading tab entirely instead of leaving 2 spaces). Used
 * for backtick fences; tilde fences do not dedent at all.
 */
function stripChars(l, n) {
  let rem = n;
  if (rem > 0 && l.extra > 0) {
    const take = Math.min(l.extra, rem);
    l.extra -= take;
    l.col += take;
    rem -= take;
  }
  while (rem > 0 && l.i < l.s.length) {
    const c = l.s.charCodeAt(l.i);
    if (c === 32) { l.i++; l.col++; rem--; }
    else if (c === 9) {
      const w = 4 - (l.col % 4);
      l.i++; l.col += w; rem--;
    } else break;
  }
}

/** Characters of leading whitespace at the cursor (extra + spaces/tabs). */
function indentChars(l) {
  let n = l.extra;
  let k = l.i;
  while (k < l.s.length) {
    const c = l.s.charCodeAt(k);
    if (c === 32 || c === 9) { n++; k++; }
    else break;
  }
  return n;
}

/** True when only spaces/tabs remain from the cursor. */
function isBlankLine(l) {
  for (let k = l.i; k < l.s.length; k++) {
    const c = l.s.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Columns of whitespace from the cursor (tabs to the next multiple of 4). */
function indentCols(l) {
  let count = l.extra;
  let col = l.col;
  let i = l.i;
  while (i < l.s.length) {
    const c = l.s.charCodeAt(i);
    if (c === 32) {
      count++;
      col++;
      i++;
    } else if (c === 9) {
      const w = 4 - (col % 4);
      count += w;
      col += w;
      i++;
    } else break;
  }
  return count;
}

/** True when the line, from the cursor, holds only spaces/tabs and ends. */
function lineIsBlank(s) {
  for (let k = 0; k < s.length; k++) {
    const c = s.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// ---- Block nodes ----------------------------------------------------------

function mkNode(t) {
  return { t, children: [] };
}

// ---- Link destinations, titles, reference definitions --------------------

/**
 * Parse a link destination at s[i]. Returns { dest, next } or null.
 * `<...>` destinations hold no `<`, newline or unescaped `>`; bare
 * destinations hold no space or control character and keep parentheses
 * balanced. Backslash escapes are resolved (the escaped character is kept).
 */
function parseLinkDestination(s, i) {
  const n = s.length;
  if (i >= n) return null;
  if (s.charCodeAt(i) === 60) {
    // <...>
    let j = i + 1;
    let dest = '';
    while (j < n) {
      const c = s.charCodeAt(j);
      if (c === 62) return { dest, next: j + 1 };
      if (c === 60 || c === 10) return null;
      if (c === 92 && j + 1 < n) {
        const d = s.charCodeAt(j + 1);
        if (isPunct(d)) {
          dest += s[j + 1];
          j += 2;
          continue;
        }
      }
      dest += s[j];
      j++;
    }
    return null;
  }
  let j = i;
  let dest = '';
  let depth = 0;
  while (j < n) {
    const c = s.charCodeAt(j);
    if (c <= 32 || c === 127) break;
    if (c === 92 && j + 1 < n) {
      const d = s.charCodeAt(j + 1);
      if (isPunct(d)) {
        dest += s[j + 1];
        j += 2;
        continue;
      }
    }
    if (c === 40) depth++;
    else if (c === 41) {
      if (depth === 0) break;
      depth--;
    }
    dest += s[j];
    j++;
  }
  if (j === i) return null;
  return { dest, next: j };
}

/**
 * Parse a link title at s[i]. Returns { title, next } or null. Titles are
 * "..." or '...' (either quote may appear inside the other, newlines are
 * kept) or (...) (no unescaped open paren inside). Backslash escapes of
 * punctuation are resolved.
 */
function parseLinkTitle(s, i) {
  const n = s.length;
  if (i >= n) return null;
  const open = s.charCodeAt(i);
  let close;
  let paren = false;
  if (open === 34 || open === 39) close = open;
  else if (open === 40) {
    close = 41;
    paren = true;
  } else return null;
  let j = i + 1;
  let title = '';
  while (j < n) {
    const c = s.charCodeAt(j);
    if (c === close) return { title, next: j + 1 };
    if (paren && c === 40) return null;
    if (c === 92 && j + 1 < n) {
      const d = s.charCodeAt(j + 1);
      if (isPunct(d)) {
        title += s[j + 1];
        j += 2;
        continue;
      }
    }
    title += s[j];
    j++;
  }
  return null;
}

/** Skip spaces, tabs and newlines from s[i]; returns the new index. */
function skipWsNl(s, i) {
  while (i < s.length && isSpace(s.charCodeAt(i))) i++;
  return i;
}

/** Collapse a link label's internal whitespace runs to single spaces. */
function normalizeLabel(label) {
  // Unicode case folding for label matching: ß and ẞ both fold to "ss"
  // (String.toLowerCase gives ß for ẞ, which would not match "SS").
  return label.replace(/\s+/g, ' ').trim().toLowerCase().replace(/ß/g, 'ss');
}

/**
 * Try to parse a link reference definition from lines[start...]. Returns
 * { lines: count, label, dest, title } or null. The definition must end at
 * a line end (only spaces/tabs may follow the title/destination on its
 * line). The label ends at the first unescaped ] (labels do not nest), may
 * span lines, and must be non-empty once its whitespace is collapsed. The
 * destination may sit on the next line; the title may sit on the same line
 * as the destination (after whitespace) or on the next line. A title on
 * the next line that turns out to have trailing content falls back to a
 * destination-only definition.
 */
function parseRefDef(lines, start) {
  // Join the lines from start: the label, destination and title may each
  // run onto a following line.
  let joined = lines[start];
  for (let k = start + 1; k < lines.length; k++) joined += '\n' + lines[k];
  // label: up to 3 spaces, then [ ... ] ending at the FIRST unescaped ]
  let p = 0;
  while (p < joined.length && joined.charCodeAt(p) === 32 && p < 3) p++;
  if (p >= joined.length || joined.charCodeAt(p) !== 91) return null;
  let q = p + 1;
  let label = '';
  let ok = false;
  while (q < joined.length) {
    const c = joined.charCodeAt(q);
    if (c === 92 && q + 1 < joined.length) {
      const d = joined.charCodeAt(q + 1);
      if (isPunct(d)) {
        // an escaped ] does not end the label, but the label is kept
        // RAW (backslash intact): a [foo\!] definition matches only a
        // [foo\!] reference, not [foo!] (cm-194 / cm-545).
        label += joined[q] + joined[q + 1];
        q += 2;
        continue;
      }
    }
    if (c === 93) {
      ok = true;
      q++;
      break;
    }
    // an unescaped [ inside a label invalidates the definition
    // (cm-546: [a[b]: /u is not a def). An escaped \[ is fine
    // (cm-549: [ref\[]: /uri is a def).
    if (c === 91) return null;
    label += joined[q];
    q++;
  }
  if (!ok || label.length === 0 || label.length > 999) return null;
  if (normalizeLabel(label) === '') return null;
  // skip spaces/tabs, expect :
  while (q < joined.length && (joined.charCodeAt(q) === 32 || joined.charCodeAt(q) === 9)) q++;
  if (q >= joined.length || joined.charCodeAt(q) !== 58) return null;
  q++;
  // Destination: spaces/tabs, then at most one newline (it may sit on the
  // next line) and its leading spaces/tabs.
  let i = q;
  while (i < joined.length && (joined.charCodeAt(i) === 32 || joined.charCodeAt(i) === 9)) i++;
  if (i < joined.length && joined.charCodeAt(i) === 10) {
    i++;
    while (i < joined.length && (joined.charCodeAt(i) === 32 || joined.charCodeAt(i) === 9)) i++;
  }
  const dest = parseLinkDestination(joined, i);
  if (!dest) return null;
  i = dest.next;
  // The destination-only end: only spaces/tabs may follow the destination
  // on its line.
  let destEnd = i;
  while (destEnd < joined.length && (joined.charCodeAt(destEnd) === 32 || joined.charCodeAt(destEnd) === 9)) destEnd++;
  const destOnlyValid = destEnd >= joined.length || joined.charCodeAt(destEnd) === 10;
  // Title: on the same line after whitespace, or on the next line, or
  // absent.
  let title = null;
  let endPos = i;
  let titleOk = false;
  let j = i;
  while (j < joined.length && (joined.charCodeAt(j) === 32 || joined.charCodeAt(j) === 9)) j++;
  if (j > i && j < joined.length && (joined.charCodeAt(j) === 34 || joined.charCodeAt(j) === 39 || joined.charCodeAt(j) === 40)) {
    const t = parseLinkTitle(joined, j);
    if (t) {
      title = t.title;
      endPos = t.next;
      titleOk = true;
    }
  } else if (j < joined.length && joined.charCodeAt(j) === 10) {
    let k = j + 1;
    while (k < joined.length && (joined.charCodeAt(k) === 32 || joined.charCodeAt(k) === 9)) k++;
    if (k < joined.length && (joined.charCodeAt(k) === 34 || joined.charCodeAt(k) === 39 || joined.charCodeAt(k) === 40)) {
      const t = parseLinkTitle(joined, k);
      if (t) {
        title = t.title;
        endPos = t.next;
        titleOk = true;
      }
    }
  }
  if (!titleOk) {
    // No valid title: the definition stands on its destination alone when
    // the destination's line is clean.
    if (!destOnlyValid) return null;
    title = null;
    endPos = i;
  }
  // Only spaces/tabs may follow the title/destination on its line.
  let end = endPos;
  while (end < joined.length && (joined.charCodeAt(end) === 32 || joined.charCodeAt(end) === 9)) end++;
  if (end < joined.length && joined.charCodeAt(end) !== 10) {
    // Trailing content after the title: fall back to the destination-only
    // definition when its line is clean.
    if (title !== null && destOnlyValid) {
      title = null;
      endPos = i;
      end = destEnd;
    } else {
      return null;
    }
  }
  // Lines consumed: newlines before `end`, plus one.
  let consumed = 1;
  for (let k = 0; k < end; k++) if (joined.charCodeAt(k) === 10) consumed++;
  // The definition must not run past the paragraph's lines.
  if (start + consumed > lines.length) return null;
  return { lines: consumed, label, dest: dest.dest, title };
}

// ---- Block parser ---------------------------------------------------------
// Node types: 0 doc, 1 blockquote, 2 list, 3 item, 4 paragraph, 5 heading,
// 6 thematic break, 7 fenced code, 8 indented code, 9 html block, 10 table.
const T_DOC = 0, T_QUOTE = 1, T_LIST = 2, T_ITEM = 3, T_PARA = 4,
  T_HEAD = 5, T_HR = 6, T_FENCE = 7, T_CODE = 8, T_HTML = 9, T_TABLE = 10;

function mkBlock(t, parent) {
  const n = { t, c: [], parent: parent || null };
  if (parent) parent.c.push(n);
  return n;
}

/** Shallow copy of a line cursor (all fields are primitives). */
function cloneL(l) {
  return { s: l.s, i: l.i, col: l.col, extra: l.extra };
}

/**
 * The remainder of a line from the cursor, with tabs in the leading
 * whitespace run expanded to spaces by column. Tabs after the first
 * non-space character are kept literally (marked preserves them).
 */
function restExp(l) {
  let out = '';
  let col = l.col;
  let extra = l.extra;
  if (extra > 0) {
    out += ' '.repeat(extra);
    col += extra;
    extra = 0;
  }
  let i = l.i;
  const s = l.s;
  let k = i;
  while (k < s.length) {
    const ch = s.charCodeAt(k);
    if (ch === 32) {
      out += ' ';
      col++;
      k++;
    } else if (ch === 9) {
      const w = 4 - (col % 4);
      out += ' '.repeat(w);
      col += w;
      k++;
    } else break;
  }
  return out + s.slice(k);
}

/** Block tag names that start an HTML block of type 6. */
const BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param section source summary table tbody td tfoot th thead title tr track ul').split(' '));

/**
 * HTML block start at the cursor. Returns { type, end } or null.
 * type 1: script/pre/style/textarea, end is the lowercase closing tag.
 * type 2: <!-- ends at -->. type 3: <? ends at ?>. type 4: <!letter ends
 * at >. type 5: <![CDATA[ ends at >. type 6: a block tag, ends at a blank
 * line. type 7: a complete open or close tag alone on the line, ends at a
 * blank line. The line may be indented up to 3 columns.
 */
function htmlStart(l) {
  const s = l.s;
  const ind = indentCols(l);
  if (ind >= 4) return null;
  const c = cloneL(l);
  adv(c, ind);
  if (cur(c) !== 60) return null; // not <
  const afterLt = c.i + 1;
  if (afterLt >= s.length) return null;
  const a = s.charCodeAt(afterLt);
  if (a === 33) {
    // <!-- or <!letter or <![CDATA[
    if (s.startsWith('<!--', afterLt - 1)) return { type: 2, end: '-->' };
    if (s.startsWith('<![CDATA[', afterLt - 1)) return { type: 5, end: '>' };
    const b = s.charCodeAt(afterLt + 1);
    if ((b >= 65 && b <= 90) || (b >= 97 && b <= 122)) return { type: 4, end: '>' };
    return null;
  }
  if (a === 63) return { type: 3, end: '?>' };
  if (a === 47) {
    // </tag ...> : type 6 if it closes a block-level tag (CommonMark
    // condition 6 allows "< or </" + block tag), else type 7 only if
    // it is the whole line. (</pre> is not type 6: pre is not a block
    // tag, so it stays paragraph content, cm-148.)
    let j = afterLt + 1;
    while (j < s.length) {
      const ch = s.charCodeAt(j);
      if ((ch >= 65 && ch <= 90) || (ch >= 97 && ch <= 122) || (ch >= 48 && ch <= 57) || ch === 45) j++;
      else break;
    }
    const name = s.slice(afterLt + 1, j).toLowerCase();
    const nx = j < s.length ? s.charCodeAt(j) : -1;
    if (BLOCK_TAGS.has(name) && (nx === -1 || nx === 32 || nx === 9 || nx === 62 || nx === 47)) return { type: 6, end: '' };
    return htmlType7(c, s);
  }
  if ((a >= 65 && a <= 90) || (a >= 97 && a <= 122)) {
    // read the tag name
    let j = afterLt;
    while (j < s.length) {
      const ch = s.charCodeAt(j);
      if ((ch >= 65 && ch <= 90) || (ch >= 97 && ch <= 122) || (ch >= 48 && ch <= 57) || ch === 45) j++;
      else break;
    }
    const name = s.slice(afterLt, j).toLowerCase();
    const nx = j < s.length ? s.charCodeAt(j) : -1;
    if (name === 'script' || name === 'pre' || name === 'style' || name === 'textarea') {
      if (nx === -1 || nx === 32 || nx === 9 || nx === 62 || nx === 47) return { type: 1, end: name };
      return null;
    }
    if (BLOCK_TAGS.has(name)) {
      if (nx === -1 || nx === 32 || nx === 9 || nx === 62 || nx === 47) return { type: 6, end: '' };
      return null;
    }
    // any other tag name: type 7 if alone on the line
    return htmlType7(c, s);
  }
  return null;
}

/** A complete open/close tag alone on the line (type 7), or null. */
function htmlType7(c, s) {
  // a type-7 block is a complete open tag alone on the line. Reuse the
  // inline tag validation, so an attribute that is not a valid attribute
  // name ("<a h*#ref=...>") is not a tag at all.
  const len = inlineHtmlLen(s, c.i);
  if (len === 0) return null;
  // only spaces/tabs may follow the tag
  const end = c.i + len;
  for (let m = end; m < s.length; m++) {
    const ch = s.charCodeAt(m);
    if (ch !== 32 && ch !== 9) return null;
  }
  return { type: 7, end: '' };
}

/**
 * ATX heading at the cursor. Returns { level, text } or null. The text is
 * the heading's inline source: opening #'s and one space removed, trailing
 * whitespace and a closing run of #'s (preceded by space/tab) removed.
 * Indent up to 3 columns.
 */
function atxInfo(l) {
  const ind = indentCols(l);
  if (ind >= 4) return null;
  const c = cloneL(l);
  adv(c, ind);
  if (cur(c) !== 35) return null;
  let level = 0;
  while (cur(c) === 35 && level < 7) {
    c.i++;
    c.col++;
    level++;
  }
  if (level > 6) return null;
  const nx = cur(c);
  if (nx !== -1 && nx !== 32 && nx !== 9) return null;
  if (nx === 32 || nx === 9) {
    while (cur(c) === 32 || cur(c) === 9) {
      if (cur(c) === 9) {
        const w = 4 - (c.col % 4);
        c.col += w;
        c.i++;
      } else {
        c.i++;
        c.col++;
      }
    }
  }
  let text = restExp(c);
  let end = text.length;
  while (end > 0 && (text.charCodeAt(end - 1) === 32 || text.charCodeAt(end - 1) === 9)) end--;
  text = text.slice(0, end);
  // closing sequence: spaces/tabs, then #'s, then end; the whole text may
  // itself be the closing run (### ### -> empty), the space after the
  // opening hashes having separated it
  let h = text.length;
  while (h > 0 && text.charCodeAt(h - 1) === 35) h--;
  if (h < text.length && (h === 0 || text.charCodeAt(h - 1) === 32 || text.charCodeAt(h - 1) === 9)) {
    let e2 = h;
    while (e2 > 0 && (text.charCodeAt(e2 - 1) === 32 || text.charCodeAt(e2 - 1) === 9)) e2--;
    text = text.slice(0, e2);
  }
  return { level, text };
}

/**
 * Fenced code start at the cursor. Returns { ch, len, info } or null.
 * Three or more backticks or tildes, indent up to 3. A backtick fence's
 * info string must not contain a backtick.
 */
function fenceInfo(l) {
  const ind = indentCols(l);
  if (ind >= 4) return null;
  const c = cloneL(l);
  adv(c, ind);
  const ch = cur(c);
  if (ch !== 96 && ch !== 126) return null;
  let len = 0;
  while (cur(c) === ch) {
    c.i++;
    c.col++;
    len++;
  }
  if (len < 3) return null;
  let info = restExp(c);
  let a = 0;
  while (a < info.length && (info.charCodeAt(a) === 32 || info.charCodeAt(a) === 9)) a++;
  let b = info.length;
  while (b > a && (info.charCodeAt(b - 1) === 32 || info.charCodeAt(b - 1) === 9)) b--;
  info = info.slice(a, b);
  if (ch === 96 && info.indexOf('`') !== -1) return null;
  return { ch: ch === 96 ? '`' : '~', len, info };
}

/** True when the line from the cursor is a closing fence for f. */
function isFenceClose(l, f) {
  const ind = indentCols(l);
  if (ind >= 4) return false;
  const c = cloneL(l);
  adv(c, ind);
  const want = f.fence === '`' ? 96 : 126;
  if (cur(c) !== want) return false;
  let len = 0;
  while (cur(c) === want) {
    c.i++;
    c.col++;
    len++;
  }
  if (len < f.len) return false;
  return isBlankLine(c);
}

/**
 * Setext underline at the cursor. Returns 1 for =, 2 for -, or 0.
 * One or more of the same character, only spaces/tabs after, indent <= 3.
 */
function setextInfo(l) {
  const ind = indentCols(l);
  if (ind >= 4) return 0;
  const c = cloneL(l);
  adv(c, ind);
  const ch = cur(c);
  if (ch !== 61 && ch !== 45) return 0;
  let n = 0;
  while (cur(c) === ch) {
    c.i++;
    c.col++;
    n++;
  }
  if (n === 0) return 0;
  return isBlankLine(c) ? (ch === 61 ? 1 : 2) : 0;
}

/**
 * Thematic break at the cursor: three or more of *, - or _ (one kind),
 * with spaces/tabs between, indent up to 3.
 */
function isHr(l) {
  const ind = indentCols(l);
  if (ind >= 4) return false;
  const c = cloneL(l);
  adv(c, ind);
  const ch = cur(c);
  if (ch !== 42 && ch !== 45 && ch !== 95) return false;
  let n = 0;
  while (true) {
    const d = cur(c);
    if (d === ch) {
      n++;
      c.i++;
      c.col++;
    } else if (d === 32 || d === 9) {
      c.i++;
      c.col++;
    } else if (d === -1) break;
    else return false;
  }
  return n >= 3;
}

/**
 * List marker at the cursor. Returns null, or an object describing the
 * marker: { kind, bullet, delim, start, markerCol, markerEnd, run }.
 * kind is 'ul' or 'ol'. markerCol is the virtual column of the marker,
 * markerEnd the column just past it, run the columns of whitespace after
 * it (-1 when the line ends right after the marker). Indent up to 3.
 */
function listMarker(l) {
  const ind = indentCols(l);
  if (ind >= 4) return null;
  const c = cloneL(l);
  adv(c, ind);
  const markerCol = c.col;
  const ch = cur(c);
  if (ch === 45 || ch === 43 || ch === 42) {
    // bullet: the next character must be space, tab or EOL
    const nx = c.i + 1 < c.s.length ? c.s.charCodeAt(c.i + 1) : -1;
    if (nx !== -1 && nx !== 32 && nx !== 9) return null;
    c.i++;
    c.col++;
    const run = wsRun(c);
    return { kind: 'ul', bullet: String.fromCharCode(ch), delim: null, start: 0, markerCol, markerEnd: c.col, run };
  }
  if (ch >= 48 && ch <= 57) {
    let j = c.i;
    let digits = 0;
    let start = 0;
    while (j < c.s.length && c.s.charCodeAt(j) >= 48 && c.s.charCodeAt(j) <= 57 && digits < 10) {
      start = start * 10 + (c.s.charCodeAt(j) - 48);
      digits++;
      j++;
    }
    if (digits === 0 || digits > 9) return null;
    if (j >= c.s.length) return null;
    const d = c.s.charCodeAt(j);
    if (d !== 46 && d !== 41) return null;
    const nx = j + 1 < c.s.length ? c.s.charCodeAt(j + 1) : -1;
    if (nx !== -1 && nx !== 32 && nx !== 9) return null;
    c.i = j + 1;
    c.col = markerCol + digits + 1;
    const run = wsRun(c);
    return { kind: 'ol', bullet: null, delim: String.fromCharCode(d), start, markerCol, markerEnd: c.col, run };
  }
  return null;
}

/**
 * Columns of whitespace (spaces/tabs) from the cursor, or -1 at EOL.
 * Does not move the cursor.
 */
function wsRun(l) {
  if (l.i >= l.s.length && l.extra === 0) return -1;
  let count = l.extra;
  let col = l.col;
  let i = l.i;
  while (i < l.s.length) {
    const ch = l.s.charCodeAt(i);
    if (ch === 32) {
      count++;
      col++;
      i++;
    } else if (ch === 9) {
      const w = 4 - (col % 4);
      count += w;
      col += w;
      i++;
    } else break;
  }
  return count;
}

/**
 * Split a table row line into cells, marked's way (splitCells): every
 * unescaped pipe becomes " |" and the row splits on " |"; a first or last
 * cell that is only whitespace is dropped (so " |  | 4731 | x |" has one
 * leading empty cell, not two); each cell is trimmed and \| becomes |.
 * A pipe is escaped when preceded by an odd run of backslashes. Other
 * backslash escapes stay raw for the inline parser.
 * Returns the array of cell strings (trimmed).
 */
function splitRow(s) {
  let row = '';
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 124) {
      let bs = 0;
      for (let k = i - 1; k >= 0 && s.charCodeAt(k) === 92; k--) bs++;
      row += bs % 2 === 1 ? '|' : ' |';
    } else {
      row += s[i];
    }
  }
  const cells = row.split(' |');
  if (cells.length > 0 && cells[0].trim() === '') cells.shift();
  if (cells.length > 0 && cells[cells.length - 1].trim() === '') cells.pop();
  return cells.map((c) => c.trim().replace(/\\\|/g, '|'));
}

/** Trim spaces and tabs from both ends of a cell string. */
function trimCell(s) {
  let a = 0;
  let b = s.length;
  while (a < b && (s.charCodeAt(a) === 32 || s.charCodeAt(a) === 9)) a++;
  while (b > a && (s.charCodeAt(b - 1) === 32 || s.charCodeAt(b - 1) === 9)) b--;
  return s.slice(a, b);
}

/**
 * Table delimiter row at the cursor. Returns { aligns, count } or null.
 * Each cell must be spaces, an optional :, one or more -, an optional :,
 * spaces. The row must contain a pipe, or be a single cell.
 */
function tableDelim(l) {
  const ind = indentCols(l);
  if (ind >= 4) return null;
  const s = restExp(l);
  let a = 0;
  while (a < s.length && s.charCodeAt(a) === 32 && a < 3) a++;
  if (a < s.length && s.charCodeAt(a) === 9) return null;
  let b = s.length;
  while (b > a && (s.charCodeAt(b - 1) === 32 || s.charCodeAt(b - 1) === 9)) b--;
  const row = s.slice(a, b);
  if (row.length === 0) return null;
  if (row.indexOf('|') === -1) {
    const m = /^ *:?-+:? *$/.exec(row);
    if (!m) return null;
    return { aligns: [delimAlign(row)], count: 1 };
  }
  const cells = splitRow(row);
  if (cells.length === 0) return null;
  const aligns = [];
  for (const cell of cells) {
    const t = trimCell(cell);
    if (!/^:?-+:?$/.test(t)) return null;
    aligns.push(delimAlign(t));
  }
  return { aligns, count: cells.length };
}

function delimAlign(t) {
  const left = t.charCodeAt(0) === 58;
  const right = t.charCodeAt(t.length - 1) === 58;
  if (left && right) return 'center';
  if (left) return 'left';
  if (right) return 'right';
  return null;
}

/**
 * Match a blockquote container against the line. Consumes the '>' and one
 * following space/tab column. When the line's indent is 4 or more columns
 * the quote does not match. The indented-code dedent for a lazy paragraph
 * line is applied by the caller, not here, so the line's real indent
 * survives for the block checks.
 */
function matchQuote(l) {
  const ind = indentCols(l);
  if (ind >= 4) return false;
  const c = cloneL(l);
  adv(c, ind);
  if (cur(c) !== 62) return false;
  // commit: consume indent and '>'
  adv(l, ind);
  l.i++;
  l.col++;
  // Consume the whitespace run after '>'. Marked tab-expands the whole
  // run from the column in the container-stripped source (where '>' sits
  // `ind` columns from the frame origin), then removes ONE space
  // (blockquoteMarkerWhitespace + blockquoteSetextReplace2): the
  // content's leading whitespace is that expansion minus one space.
  // So a space followed by a tab leaves the tab's full width as leading
  // spaces (L0: `  > \tindented` in a `-` item gives 2 spaces, not 4),
  // and a tab directly after '>' leaves its width minus one.
  let sc = ind + 1; // stripped column of the first whitespace char
  let e = 0; // expanded length of the run
  let k = l.i;
  let absCol = l.col;
  while (k < l.s.length) {
    const ch = l.s.charCodeAt(k);
    if (ch === 32) { e += 1; sc += 1; absCol += 1; k++; }
    else if (ch === 9) {
      const w = 4 - (sc % 4);
      e += w; sc += w;
      absCol += 4 - (absCol % 4); k++;
    } else break;
  }
  if (k > l.i) {
    l.extra = Math.max(0, e - 1);
    l.i = k;
    l.col = absCol;
  }
  return true;
}

/**
 * Match a list item container against the line. The item's content indent
 * is relative to the cursor column where the item's line started after its
 * containers: the absolute columns of two lines differ when their
 * container prefixes (e.g. blockquotes) have different widths, so compare
 * this line's indent after its containers against the item's relative
 * content indent, and advance the cursor by that amount. A blank
 * remainder always matches. Returns true on match.
 */
function matchItem(l, item) {
  if (isBlankLine(l)) return true;
  const rel = item.indent - item.baseCol;
  // test the advance on a clone: on failure the cursor must be untouched,
  // or the line's leading spaces are eaten and a following paragraph loses
  // them (e.g. "- one\n\n two" must keep the space in " two")
  const c = cloneL(l);
  if (adv(c, rel) < rel) return false;
  adv(l, rel);
  return true;
}

// ---- Block tree construction -------------------------------------------

/**
 * Parse lines into a block tree. Returns { doc, refs } where refs maps a
 * normalized link label to { dest, title }. endsWithNl says whether the
 * original input ended with a newline (a top-level HTML block at EOF keeps
 * its trailing newline only then).
 */
function parseBlocks(lines, endsWithNl) {
  const doc = mkBlock(T_DOC, null);
  const stack = [doc];
  const refs = new Map();
  const tip = () => stack[stack.length - 1];

  function deepestList() {
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i].t === T_LIST) return stack[i];
    }
    return null;
  }

  /** Strip leading ref defs from a paragraph's lines; returns the rest. */
  function stripDefs(lineArr) {
    let start = 0;
    while (start < lineArr.length) {
      const def = parseRefDef(lineArr, start);
      if (!def) break;
      const key = normalizeLabel(def.label);
      if (!refs.has(key)) refs.set(key, { dest: def.dest, title: def.title });
      start += def.lines;
    }
    return lineArr.slice(start);
  }

  function finalize(b) {
    if (b.t === T_PARA) {
      const restLines = stripDefs(b.lines);
      if (restLines.length === 0) {
        const p = b.parent;
        const ix = p.c.indexOf(b);
        if (ix !== -1) p.c.splice(ix, 1);
        b.lines = [];
      } else {
        b.lines = restLines;
      }
    } else if (b.t === T_CODE) {
      let n = b.lines.length;
      while (n > 0 && lineIsBlank(b.lines[n - 1])) n--;
      b.lines.length = n;
    } else if (b.t === T_FENCE) {
      // a fenced block loses exactly one trailing blank line (the line
      // break before the closing fence); an indented block loses all.
      // Only a truly empty line is stripped: a line of spaces is content.
      if (b.lines.length > 0 && b.lines[b.lines.length - 1] === '') b.lines.length--;
    } else if (b.t === T_HTML) {
      b.text = b.lines.join('\n') + (b.trail ? '\n' : '');
    }
  }

  function closeTo(n) {
    while (stack.length > n) finalize(stack.pop());
  }

  function listsMatch(list, m) {
    if (list.kind !== m.kind) return false;
    if (m.kind === 'ul') return list.bullet === m.bullet;
    return list.delim === m.delim;
  }

  /**
   * A new block (not a list item) is about to be added under `parent`.
   * Consumes the deepest open list's pending blank: it makes the list loose
   * when the block is a further child of an item of that list which already
   * has a block. The list checked is the one owning the parent item, so a
   * blank line between a nested list and a following paragraph in the
   * outer item loosens the outer list, not just the nested one.
   */
  function noteNewBlock(parent) {
    let L = null;
    if (parent.t === T_ITEM) L = parent.parent;
    else L = deepestList();
    if (!L || !L.pend) return;
    if (parent.t === T_ITEM && parent.c.length > 0) {
      L.loose = true;
    }
    for (const b of stack) {
      if (b.t === T_LIST) b.pend = false;
    }
  }

  /**
   * A blank line was processed as a separator: pend the lists it is
   * directly inside. Walk up from `deepest` (the deepest container the
   * blank line matched) through list/item containers only, pending each
   * list met. A blank line inside a quote (or other non-list container)
   * pends nothing: it belongs to that container, not to the list
   * (cm-320). A blank line directly in an item pends that item's list
   * and, through nested lists, every ancestor list (cm-259, cm-325,
   * cm-326).
   */
  function noteBlank(deepest) {
    let b = deepest;
    while (b) {
      if (b.t === T_LIST) { b.pend = true; b = b.parent; continue; }
      if (b.t === T_ITEM) { b = b.parent; continue; }
      break;
    }
  }

  /**
   * Create a list item in `list` from the marker m, advancing the cursor
   * past the marker and its following whitespace. Handles the task
   * checkbox on the item's first line. Pushes the item and returns it, or
   * returns the item with no content when the line ends at the marker.
   */
  function addItem(list, l, m) {
    if (list.pend) {
      list.loose = true;
      list.pend = false;
    }
    // a blank line between items of THIS list pends the list and, via
    // noteBlank's walk-up, its ancestors — but it separates only this
    // list's items, so the ancestors must not go loose when a later
    // item of theirs is added: clear their stale pend here (a blank
    // INSIDE an item is not consumed by an item add, so cm-325/326,
    // where the next line is a paragraph continuation, are unaffected).
    let p = list.parent;
    while (p) {
      if (p.t === T_LIST) p.pend = false;
      p = p.parent;
    }
    const item = mkBlock(T_ITEM, list);
    item.task = 0;
    // the cursor column at entry is the start of this line's content
    // after its containers: the item's content indent is measured from
    // here, so later lines (whose container prefixes may be wider or
    // narrower) compare against the same relative indent.
    item.baseCol = l.col;
    // the marker column, for the lazy-line dedent (indent − markerCol is
    // the marker width plus its following spaces)
    item.markerCol = m.markerCol;
    // advance to the marker, then past it
    adv(l, m.markerCol - l.col);
    if (m.kind === 'ul') {
      l.i++;
      l.col++;
    } else {
      // advance past the whole marker, e.g. "003." is 4 columns, not
      // String(start).length + 1 = 2
      const w = m.markerEnd - m.markerCol;
      l.i += w;
      l.col += w;
    }
    if (m.run === -1) {
      item.indent = m.markerEnd + 1;
      stack.push(item);
      return item;
    }
    if (m.run >= 5) {
      item.indent = m.markerEnd + 1;
      adv(l, 1);
    } else {
      adv(l, m.run);
      item.indent = l.col;
    }
    if (isBlankLine(l)) {
      item.indent = m.markerEnd + 1;
      stack.push(item);
      return item;
    }
    // task checkbox: [ ] [x] [X], one space/tab, then more content
    const content = rest(l);
    if (content.length > 4 && content.charCodeAt(0) === 91) {
      const mid = content.charCodeAt(1);
      if ((mid === 32 || mid === 120 || mid === 88) && content.charCodeAt(2) === 93) {
        const after = content.charCodeAt(3);
        if (after === 32 || after === 9) {
          let hasContent = false;
          for (let k = 4; k < content.length; k++) {
            if (content.charCodeAt(k) !== 32 && content.charCodeAt(k) !== 9) {
              hasContent = true;
              break;
            }
          }
          if (hasContent) {
            item.task = mid === 32 ? 1 : 2;
            l.i += 3;
            l.col += 3;
            // consume ALL spaces/tabs after the checkbox: the renderer
            // supplies exactly one space before the content, however
            // many spaces/tabs followed the ] (gfm-279/280).
            while (l.i < l.s.length) {
              const ch = l.s.charCodeAt(l.i);
              if (ch === 32) {
                l.i++;
                l.col++;
              } else if (ch === 9) {
                l.col += 4 - (l.col % 4);
                l.i++;
              } else break;
            }
          }
        }
      }
    }
    stack.push(item);
    return item;
  }

  /**
   * Open a list item from the marker m at the cursor. Handles the sublist
   * case (marker at or past the containing item's content indent), joining
   * the open list, and starting a fresh list. Returns true.
   */
  function openList(l, m) {
    const parent = tip();
    // sublist: the tip is an item, or a leaf directly inside an item, and
    // the marker sits at or past that item's content indent
    let itemParent = null;
    if (parent.t === T_ITEM) itemParent = parent;
    else if (parent.parent && parent.parent.t === T_ITEM && parent.t !== T_LIST && parent.t !== T_QUOTE && parent.t !== T_DOC) itemParent = parent.parent;
    if (itemParent && m.markerCol >= itemParent.indent) {
      noteNewBlock(itemParent);
      const list = mkBlock(T_LIST, itemParent);
      list.kind = m.kind;
      list.bullet = m.bullet;
      list.delim = m.delim;
      list.start = m.start;
      list.loose = false;
      list.pend = false;
      stack.push(list);
      addItem(list, l, m);
      return true;
    }
    // join the open list, or the parent's last child list, or start fresh
    let list = null;
    if (parent.t === T_LIST) {
      if (listsMatch(parent, m)) {
        list = parent;
      } else {
        closeTo(stack.length - 1);
      }
    }
    if (!list) {
      const p2 = tip();
      const last = p2.c.length > 0 ? p2.c[p2.c.length - 1] : null;
      if (last && last.t === T_LIST && listsMatch(last, m)) list = last;
    }
    if (!list) {
      const p2 = tip();
      noteNewBlock(p2);
      list = mkBlock(T_LIST, p2);
      list.kind = m.kind;
      list.bullet = m.bullet;
      list.delim = m.delim;
      list.start = m.start;
      list.loose = false;
      list.pend = false;
      stack.push(list);
    }
    addItem(list, l, m);
    return true;
  }

  /** True when the line starts a blockquote (<=3 indent, then '>'). */
  function isQuoteStart(l) {
    const ind = indentCols(l);
    if (ind >= 4) return false;
    const c = cloneL(l);
    adv(c, ind);
    return cur(c) === 62;
  }

  /** Does the line start a block that interrupts a paragraph? */
  function interruptsPara(l) {
    if (atxInfo(l)) return true;
    if (fenceInfo(l)) return true;
    const h = htmlStart(l);
    if (h && h.type <= 6) return true;
    if (setextInfo(l)) return true;
    if (isHr(l)) return true;
    if (isQuoteStart(l)) return true;
    const m = listMarker(l);
    if (m && m.run !== -1) {
      if (m.kind === 'ul') return true;
      if (m.start === 1) return true;
      // inside a list item an ordered list may start with any number:
      // it is a NESTED list, not an interruption of a top-level
      // paragraph (+ item / 5. nested starts <ol start="5">; but a
      // top-level paragraph followed by 5. stays a paragraph).
      let p = tip();
      while (p && p.t !== T_DOC) {
        if (p.t === T_ITEM) return true;
        p = p.parent;
      }
    }
    return false;
  }

  /**
   * Indented-code start for marked's table rule: 4 spaces, or 0-3 spaces
   * and a tab, followed by any character. A lone tab (or " \t") has no
   * character after the indent, so it is NOT code — it continues the table
   * as an empty row.
   */
  function tableCodeStart(s) {
    let i = 0;
    let spaces = 0;
    while (i < s.length && s.charCodeAt(i) === 32 && spaces < 4) { i++; spaces++; }
    if (spaces === 4) return i < s.length;
    if (i < s.length && s.charCodeAt(i) === 9) return i + 1 < s.length;
    return false;
  }

  /**
   * Does the line start any block (used to end a table's body)? ATX, fence,
   * HTML types 1-6, thematic break, blockquote, an interrupting list, or
   * indented code all end it. Type-7 HTML, setext === and an empty or
   * non-1 ordered list do not.
   */
  function startsBlockForTable(l) {
    // A spaces-only remainder is a blank line for the table rule.
    if (/^ *$/.test(rest(l))) return true;
    if (atxInfo(l)) return true;
    if (fenceInfo(l)) return true;
    const h = htmlStart(l);
    if (h && h.type <= 6) return true;
    if (isHr(l)) return true;
    if (isQuoteStart(l)) return true;
    const m = listMarker(l);
    if (m && m.run !== -1) {
      if (m.kind === 'ul') return true;
      // Marked's table rule only stops for an ordered marker starting
      // at 1; "2. foo" and "3. foo" are table rows, not lists.
      if (m.start === 1) return true;
    }
    // Indented code needs a character after the indent; a lone tab (or
    // " \t") has none, so it continues the table as an empty row.
    if (tableCodeStart(rest(l))) return true;
    return false;
  }

  /** True when the line (from the cursor) holds an HTML block's end. */
  function htmlEndsAt(l, hb) {
    const s = rest(l);
    if (hb.htype === 1) {
      // </tag ...> case-insensitively
      const lower = s.toLowerCase();
      const tag = '</' + hb.end;
      let ix = lower.indexOf(tag);
      while (ix !== -1) {
        let j = ix + tag.length;
        while (j < lower.length && (lower.charCodeAt(j) === 32 || lower.charCodeAt(j) === 9)) j++;
        if (j < lower.length && lower.charCodeAt(j) === 62) return true;
        ix = lower.indexOf(tag, ix + 1);
      }
      return false;
    }
    if (hb.htype === 2) return s.indexOf('-->') !== -1;
    if (hb.htype === 3) return s.indexOf('?>') !== -1;
    return s.indexOf('>') !== -1;
  }

  /**
   * Open new blocks from a non-blank line while the tip is a container.
   * Loops so a blockquote or list item can itself open a block inside it.
   */
  function openNewBlocks(l) {
    for (;;) {
      const t = tip();
      if (isBlankLine(l)) return;
      // a block that is not a list item never lives directly under a list:
      // close the list and retry under its parent (a continuing item is
      // left alone; the listMarker branch below opens it). A thematic
      // break outranks a list marker (* * * is an hr, not an item).
      if (t.t === T_LIST) {
        const lm = listMarker(l);
        if (isHr(l) || !lm || !listsMatch(t, lm)) {
          closeTo(stack.length - 1);
          continue;
        }
      }
      const atx = atxInfo(l);
      if (atx) {
        noteNewBlock(t);
        const h = mkBlock(T_HEAD, t);
        h.level = atx.level;
        h.text = atx.text;
        return;
      }
      const f = fenceInfo(l);
      if (f) {
        noteNewBlock(t);
        const fb = mkBlock(T_FENCE, t);
        fb.fence = f.ch;
        fb.len = f.len;
        fb.info = f.info;
        fb.indent = indentCols(l);
        fb.indentChars = indentChars(l);
        fb.lines = [];
        stack.push(fb);
        return;
      }
      const hs = htmlStart(l);
      if (hs) {
        noteNewBlock(t);
        const hb = mkBlock(T_HTML, t);
        hb.htype = hs.type;
        hb.end = hs.end;
        hb.lines = [restExp(l)];
        // types 1-5 may already end on the opening line (<style>..</style>)
        hb.done = hs.type <= 5 && htmlEndsAt(l, hb);
        hb.trail = false;
        stack.push(hb);
        return;
      }
      if (isHr(l)) {
        noteNewBlock(t);
        mkBlock(T_HR, t);
        return;
      }
      const m = listMarker(l);
      if (m) {
        openList(l, m);
        if (isBlankLine(l)) return;
        continue;
      }
      if (indentCols(l) >= 4) {
        noteNewBlock(t);
        const cb = mkBlock(T_CODE, t);
        cb.lines = [];
        stack.push(cb);
        adv(l, 4);
        cb.lines.push(rest(l));
        return;
      }
      if (isQuoteStart(l)) {
        noteNewBlock(t);
        const qb = mkBlock(T_QUOTE, t);
        stack.push(qb);
        matchQuote(l);
        continue;
      }
      noteNewBlock(t);
      const p = mkBlock(T_PARA, t);
      p.lines = [restExp(l)];
      stack.push(p);
      return;
    }
  }

  for (let li = 0; li < lines.length; li++) {
    const l = lineOf(lines[li]);
    // whether the source line itself is blank (empty / whitespace only).
    // A container-only line such as ">" is not a real blank line: it ends
    // the paragraph inside the container but must not loosen a list.
    const sourceBlank = isBlankLine(l);
    // ---- Phase 1: match open containers ----
    let idx = 1;
    let matchedAll = true;
    while (idx < stack.length) {
      const b = stack[idx];
      if (b.t === T_QUOTE) {
        if (!matchQuote(l)) {
          matchedAll = false;
          break;
        }
      } else if (b.t === T_ITEM) {
        if (!matchItem(l, b)) {
          matchedAll = false;
          break;
        }
      } else if (b.t === T_LIST) {
        // transparent
      } else {
        break; // leaf
      }
      idx++;
    }
    // A line is blank only if the source line was blank, or nothing
    // remains after container matching (no characters and no virtual
    // tab spaces). Whitespace left after a container marker is content,
    // not a blank line: ">  " (quote + 2 spaces) is a paragraph line
    // " " inside the quote, not a blank line (cm-241).
    const blank = sourceBlank || (l.i >= l.s.length && l.extra === 0);
    // The deepest container the line matched (for blank-line looseness).
    const deepest = idx >= 1 ? stack[idx - 1] : null;
    // A finished HTML block (types 1-5, closing line already fed) ends
    // here; its trailing newline survives before any line that is not
    // truly empty — a whitespace-only line (tab / spaces) still carries
    // the newline in marked's output (<!-- -->\n\t\nBar -> -->\n<p>),
    // while a truly empty line does not (<!-- -->\n\nBar -> --><p>).
    // A container-only line (">" — blank after its marker is consumed)
    // is a blank separator, not a following block, so it does not carry
    // the newline (doc-30: <!-- note --> in a quote, then ">").
    if (tip().t === T_HTML && tip().done) {
      tip().trail = !blank || (sourceBlank && l.s.length > 0);
      closeTo(stack.length - 1);
    }

    if (blank) {
      // ---- blank line ----
      if (!matchedAll) closeTo(idx);
      // an empty list item ends at a blank line: it can never gain content
      // after one ("-\n\n  foo" leaves the item empty and foo a paragraph).
      // The list itself stays open: a later marker still joins it.
      if (tip().t === T_ITEM && tip().c.length === 0) {
        closeTo(stack.length - 1);
      }
      const tt = tip();
      // noteBlank (list looseness) for any blank line, including a
      // container-only line such as ">>": it separates two blocks inside
      // a list item just as a real blank line does (cm-259).
      const nb = () => { noteBlank(deepest); };
      if (tt.t === T_PARA) {
        closeTo(stack.length - 1);
        nb();
      } else if (tt.t === T_FENCE) {
        // a blank line keeps its spaces, minus the fence's indent (in
        // characters for a backtick fence; a tilde fence does not
        // dedent)
        const c = cloneL(l);
        stripChars(c, tt.fence === '`' ? tt.indentChars : 0);
        tt.lines.push(rest(c));
      } else if (tt.t === T_CODE) {
        // a blank line keeps its spaces, minus the 4-column code indent
        const c = cloneL(l);
        adv(c, 4);
        tt.lines.push(rest(c));
      } else if (tt.t === T_HTML) {
        if (tt.htype <= 5) {
          tt.lines.push('');
        } else {
          tt.trail = false;
          closeTo(stack.length - 1);
          nb();
        }
      } else if (tt.t === T_TABLE) {
        // Marked's table body only ends on a spaces-only line (` *\n`).
        // A whitespace-only line holding a tab (or VT/FF) continues the
        // table as an EMPTY row — unless it is the final line of the
        // input without a trailing newline, which marked's trailing
        // `\n[ \t]*$` strip removes. A code-shaped whitespace line
        // (e.g. "\t " or "\t\t") ends the table as indented code.
        const ws = rest(l);
        if (/^ *$/.test(ws) || tableCodeStart(ws)) {
          closeTo(stack.length - 1);
          nb();
        } else if (li === lines.length - 1 && !endsWithNl) {
          closeTo(stack.length - 1);
          nb();
        } else {
          tt.rows.push([]);
        }
      } else {
        // inside a container: a plain separator
        nb();
      }
      continue;
    }

    // ---- non-blank line ----
    if (!matchedAll) {
      const t = tip();
      if (t.t === T_PARA) {
        // The lazy dedent: when a line fails to match its container and
        // joins the paragraph as a lazy line, four columns are consumed
        // when the line is indented four or more columns; a less-indented
        // lazy line keeps its leading spaces.
        const dedentAmt = indentCols(l) >= 4 ? 4 : 0;
        const lazyLine = () => {
          if (!dedentAmt) return restExp(l);
          const c = cloneL(l);
          adv(c, dedentAmt);
          return restExp(c);
        };
        // a lazy setext level-1 underline never makes a heading and never
        // interrupts: it joins the paragraph as a line. When the previous
        // line was lazy too, the line is rendered with four leading spaces
        // (unless it starts with a tab or already has five or more).
        if (setextInfo(l) === 1) {
          let line = lazyLine();
          if (t.lastLazy && line.charCodeAt(0) !== 9) {
            let sp = 0;
            while (sp < line.length && line.charCodeAt(sp) === 32) sp++;
            if (sp < 5) line = '    ' + line.slice(sp);
          }
          t.lines.push(line);
          t.lastLazy = true;
          continue;
        }
        // lazy continuation, unless the line opens an interrupting block
        // or continues the open list with a new item (even an empty one:
        // "2." after "1. foo" starts a new item, it is not a lazy line).
        // The list only continues when it is above the point where
        // container matching failed: a marker outside a failed quote
        // ("> - foo" then "- bar") does not join that quote's list.
        const dl = deepestList();
        const lm = dl ? listMarker(l) : null;
        if (lm && stack.indexOf(dl) < idx && listsMatch(dl, lm)) {
          closeTo(stack.indexOf(dl) + 1);
          openNewBlocks(l);
        } else if (lm && lm.run !== -1 && stack.indexOf(dl) < idx && !listsMatch(dl, lm)) {
          // a non-empty marker with a different bullet/delimiter ends the
          // open list and starts a new one ("1. foo\n2. bar\n3) baz"):
          // the start-with-1 rule does not apply inside a list
          closeTo(stack.indexOf(dl));
          openNewBlocks(l);
        } else if (lm && lm.run !== -1 && dl && stack.indexOf(dl) >= idx) {
          // a marker that fails to match an outer container (the deepest
          // list sits at or below the failure point) closes the failed
          // containers and starts a new block at the outer level: the
          // paragraph inside the failed containers is already closed by
          // the mismatch, so the start-with-1 rule does not apply
          // ("- foo\n  - a\n  - b\n2. bar" starts a new list, it is not
          // a lazy line of b's paragraph).
          closeTo(idx);
          openNewBlocks(l);
        } else if (interruptsPara(l)) {
          closeTo(idx);
          openNewBlocks(l);
        } else if (tableDelim(l) && t.lines.length > 0) {
          // a table delimiter converts the paragraph (handled below)
          closeTo(idx);
          openNewBlocks(l);
        } else {
          t.lines.push(lazyLine());
          t.lastLazy = true;
        }
        continue;
      }
      if (t.t === T_FENCE && stack[idx] && stack[idx].t === T_ITEM) {
        // A fenced code block inside a list item absorbs a content line
        // even when it does not match the item — but ONLY once the fence
        // already holds content, or when the line is still inside the
        // item (absolute indent >= the item's content indent). The
        // FIRST content line must be inside the item: a fence whose
        // first line is outside stays EMPTY (marked: + item / ```sh /
        // code0 leaves the fence empty, code0 becomes a paragraph, and
        // the closing fence opens a fresh fence — doc-13). Once the
        // fence has content it absorbs every later line at any indent
        // until the closing fence (marked absorbs `function f(a,b){` at
        // indent 0 after two indented lines — doc-02). Backtick fences
        // strip the fence indent, tilde fences do not; a leading tab
        // expands by column inside the item (restExp).
        // Two guards (doc-36): the fence must sit DIRECTLY in the
        // failed item (a fence inside a quote inside the item does not
        // absorb — the quote closes first), and the line must not start
        // a block that interrupts the fence at the outer level (a
        // closing/opening fence, blockquote, hr, ATX heading, list
        // marker or HTML block all close the fence and start the new
        // block; a plain line, setext underline or table delimiter is
        // absorbed).
        const item = stack[idx];
        let interrupts = false;
        if (t.parent === item) {
          interrupts = isFenceClose(l, t) || fenceInfo(l) !== null || isHr(l) || atxInfo(l) !== null || listMarker(l) !== null || htmlStart(l) !== null;
          if (!interrupts) {
            const ind = indentCols(l);
            if (ind < 4) {
              const c = cloneL(l);
              adv(c, ind);
              interrupts = cur(c) === 62;
            }
          }
        }
        const absIndent = l.col + indentCols(l);
        if (t.parent === item && !interrupts && (t.lines.length > 0 || absIndent >= item.indent)) {
          const strip = t.fence === '`' ? t.indentChars : 0;
          stripChars(l, strip);
          t.lines.push(restExp(l));
          continue;
        }
      }
      closeTo(idx);
    }

    const t = tip();
    // ---- leaf continuation ----
    if (t.t === T_PARA) {
      const sx = setextInfo(l);
      if (sx) {
        const restLines = stripDefs(t.lines);
        const parent = t.parent;
        parent.c.pop();
        stack.pop();
        if (restLines.length > 0) {
          const h = mkBlock(T_HEAD, parent);
          h.level = sx;
          // a setext heading's content is trimmed: leading spaces/tabs of
          // the first line and trailing spaces/tabs of the last line go
          let ht = restLines.join('\n');
          let a = 0;
          while (a < ht.length && (ht.charCodeAt(a) === 32 || ht.charCodeAt(a) === 9)) a++;
          let b = ht.length;
          while (b > a && (ht.charCodeAt(b - 1) === 32 || ht.charCodeAt(b - 1) === 9)) b--;
          h.text = ht.slice(a, b);
        } else {
          openNewBlocks(l);
        }
        continue;
      }
      const d = tableDelim(l);
      if (d) {
        const restLines = stripDefs(t.lines);
        if (restLines.length > 0) {
          const headCells = splitRow(restLines[restLines.length - 1]).map(trimCell);
          if (headCells.length === d.count) {
            const parent = t.parent;
            parent.c.pop();
            stack.pop();
            const before = restLines.slice(0, restLines.length - 1);
            if (before.length > 0) {
              const p2 = mkBlock(T_PARA, parent);
              p2.lines = before;
            }
            const table = mkBlock(T_TABLE, parent);
            table.head = headCells;
            table.align = d.aligns;
            table.rows = [];
            stack.push(table);
            continue;
          }
        }
      }
      if (interruptsPara(l)) {
        closeTo(stack.length - 1);
        openNewBlocks(l);
        continue;
      }
      t.lines.push(restExp(l));
      t.lastLazy = false;
      continue;
    }
    if (t.t === T_FENCE) {
      if (isFenceClose(l, t)) {
        closeTo(stack.length - 1);
      } else {
        // Backtick fences strip up to the fence indent from each content
        // line, counting CHARACTERS not columns (marked's Dt: a tab in
        // the indent counts as one character, so a fence of indent 2
        // drops a leading tab entirely instead of leaving 2 spaces);
        // tilde fences do not strip the indent at all (marked quirk,
        // verified by probing). Inside a container (quote/list)
        // a leading tab in the content expands to spaces by column
        // (restExp); at the top level the tab is kept literally (rest).
        // For a fence DIRECTLY inside a blockquote, marked expands the
        // tab as if the column were that of the innermost quote's
        // content (2), not the absolute column (nested quotes would
        // over-count) — but ONLY when nothing was stripped, and only
        // when the fence's parent IS the quote: a fence inside a list
        // item (even one inside a quote) expands the tab from its
        // natural column after the item prefix (>    ```sh in an item
        // gives 3 spaces, not 2). A backtick fence with indent > 0
        // already advanced the cursor past the fence indent, so the tab
        // expands from its actual column after the strip.
        const strip = t.fence === '`' ? t.indentChars : 0;
        stripChars(l, strip);
        if (t.parent.t === T_DOC) {
          t.lines.push(rest(l));
        } else if (t.parent.t === T_QUOTE && strip === 0) {
          const c2 = cloneL(l);
          c2.col = 2;
          t.lines.push(restExp(c2));
        } else {
          t.lines.push(restExp(l));
        }
      }
      continue;
    }
    if (t.t === T_CODE) {
      if (indentCols(l) >= 4) {
        adv(l, 4);
        t.lines.push(rest(l));
      } else {
        closeTo(stack.length - 1);
        openNewBlocks(l);
      }
      continue;
    }
    if (t.t === T_HTML) {
      if (t.htype <= 5) {
        t.lines.push(rest(l));
        if (htmlEndsAt(l, t)) t.done = true;
      } else {
        t.lines.push(rest(l));
      }
      continue;
    }
    if (t.t === T_TABLE) {
      if (startsBlockForTable(l)) {
        closeTo(stack.length - 1);
        openNewBlocks(l);
      } else {
        t.rows.push(splitRow(restExp(l)).map(trimCell));
      }
      continue;
    }
    // ---- tip is a container: open new blocks ----
    openNewBlocks(l);
  }

  // End of input: close everything left open.
  while (stack.length > 1) {
    const b = stack[stack.length - 1];
    if (b.t === T_HTML) {
      b.trail = b.parent === doc && endsWithNl;
    }
    finalize(stack.pop());
  }
  return { doc, refs };
}

// ---- Inline parser -------------------------------------------------------
// Single pass over the inline source with a delimiter stack. Delimiters
// are `*`, `_`, `~` (emphasis/strikethrough) and `[` (link/image openers).
// Links form when a `]` is met; emphasis is resolved afterwards, pairing
// only delimiters that share a link scope (a closer inside a link cannot
// pair with an opener outside it, and vice versa).

/** A scheme for an autolink: letter, then 1-31 letters/digits/+/./-. */
function schemeAt(s, i) {
  const n = s.length;
  if (i >= n) return 0;
  const a = s.charCodeAt(i);
  if (!((a >= 65 && a <= 90) || (a >= 97 && a <= 122))) return 0;
  let j = i + 1;
  while (j < n) {
    const c = s.charCodeAt(j);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 46 || c === 45) j++;
    else break;
  }
  const len = j - i;
  if (len < 2 || len > 32) return 0;
  return len;
}

/**
 * An autolink <...> at s[i]. Returns { url, email, next } or null.
 * <scheme:...> or <email>. The URL must hold no space, < or newline.
 */
function parseAutolink(s, i) {
  const n = s.length;
  if (i >= n || s.charCodeAt(i) !== 60) return null;
  let j = i + 1;
  // scheme:...
  const sl = schemeAt(s, j);
  if (sl > 0 && j + sl < n && s.charCodeAt(j + sl) === 58) {
    let k = j + sl + 1;
    while (k < n) {
      const c = s.charCodeAt(k);
      if (c === 32 || c === 10 || c === 60 || c === 62) break;
      k++;
    }
    if (k < n && s.charCodeAt(k) === 62 && k > j + sl + 1) {
      return { url: s.slice(j, k), email: false, next: k + 1 };
    }
    return null;
  }
  // email: local@domain, no spaces or < > inside
  let k = j;
  let at = -1;
  while (k < n) {
    const c = s.charCodeAt(k);
    if (c === 62) break;
    if (c === 32 || c === 10 || c === 60) return null;
    if (c === 64) {
      if (at !== -1) return null;
      at = k;
    }
    k++;
  }
  if (k >= n || s.charCodeAt(k) !== 62 || at === -1) return null;
  const inner = s.slice(j, k);
  if (!/^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/.test(inner)) return null;
  return { url: inner, email: true, next: k + 1 };
}

/**
 * Inline raw HTML at s[i]. Returns its length, or 0. Handles a tag
 * (quoted attribute values may hold '>'), a comment, a processing
 * instruction, a declaration and CDATA.
 */
function inlineHtmlLen(s, i) {
  const n = s.length;
  if (i >= n || s.charCodeAt(i) !== 60) return 0;
  if (s.startsWith('<!--', i)) {
    // <!--> and <!---> are complete (abruptly closed) empty comments
    // (cm-626); otherwise the comment runs to the next -->.
    if (s.startsWith('<!-->', i)) return 5;
    if (s.startsWith('<!--->', i)) return 6;
    const e = s.indexOf('-->', i + 4);
    if (e === -1) return 0;
    return e + 3 - i;
  }
  if (s.startsWith('<?', i)) {
    const e = s.indexOf('?>', i + 2);
    if (e === -1) return 0;
    return e + 2 - i;
  }
  if (s.startsWith('<![CDATA[', i)) {
    const e = s.indexOf(']]>', i + 9);
    if (e === -1) return 0;
    return e + 3 - i;
  }
  if (s.startsWith('<!', i)) {
    const a = i + 2 < n ? s.charCodeAt(i + 2) : -1;
    if ((a >= 65 && a <= 90) || (a >= 97 && a <= 122)) {
      const e = s.indexOf('>', i + 2);
      if (e === -1) return 0;
      return e + 1 - i;
    }
    return 0;
  }
  let j = i + 1;
  const closing = j < n && s.charCodeAt(j) === 47;
  if (closing) j++;
  if (j >= n) return 0;
  const a = s.charCodeAt(j);
  if (!((a >= 65 && a <= 90) || (a >= 97 && a <= 122))) return 0;
  while (j < n) {
    const c = s.charCodeAt(j);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45) j++;
    else break;
  }
  // right after the tag name only whitespace, / or > may follow: a
  // backslash there is not a tag ("<foo\>" is plain text), and neither
  // is an attribute name or ":" ("<m:abc>" is plain text).
  if (j < n) {
    const c = s.charCodeAt(j);
    if (c !== 32 && c !== 9 && c !== 10 && c !== 13 && c !== 47 && c !== 62) return 0;
  }
  if (closing) {
    // a closing tag takes no attributes: only whitespace, an optional
    // slash, then ">" (e.g. "</a href=\"foo\">" is plain text).
    let k = j;
    while (k < n && (s.charCodeAt(k) === 32 || s.charCodeAt(k) === 9 || s.charCodeAt(k) === 10 || s.charCodeAt(k) === 13)) k++;
    if (k < n && s.charCodeAt(k) === 47) {
      k++;
      while (k < n && (s.charCodeAt(k) === 32 || s.charCodeAt(k) === 9 || s.charCodeAt(k) === 10 || s.charCodeAt(k) === 13)) k++;
    }
    if (k < n && s.charCodeAt(k) === 62) return k + 1 - i;
    return 0;
  }
  // scan the tag body, validating attribute names: an attribute name is
  // letters/digits/_/:/-/. followed by an optional =value (quoted or
  // unquoted). Anything else (e.g. * or # in "<a h*#ref=...>") is not a tag.
  // After a value, whitespace (or / or >) must follow before the next
  // attribute: "<a href='bar'title=title>" is plain text.
  let k = j;
  while (k < n) {
    const c = s.charCodeAt(k);
    if (c === 32 || c === 9 || c === 10 || c === 13) { k++; continue; }
    if (c === 62) return k + 1 - i;
    if (c === 47) {
      // a self-closing slash must be immediately followed by ">":
      // "<bar/ >" is plain text (cm-621).
      if (k + 1 < n && s.charCodeAt(k + 1) === 62) return k + 2 - i;
      return 0;
    }
    if (c === 60) return 0;
    // attribute name
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 58)) return 0;
    while (k < n) {
      const d = s.charCodeAt(k);
      if ((d >= 65 && d <= 90) || (d >= 97 && d <= 122) || (d >= 48 && d <= 57) || d === 95 || d === 58 || d === 45 || d === 46) k++;
      else break;
    }
    while (k < n && (s.charCodeAt(k) === 32 || s.charCodeAt(k) === 9 || s.charCodeAt(k) === 10 || s.charCodeAt(k) === 13)) k++;
    if (k < n && s.charCodeAt(k) === 61) {
      k++;
      while (k < n && (s.charCodeAt(k) === 32 || s.charCodeAt(k) === 9 || s.charCodeAt(k) === 10 || s.charCodeAt(k) === 13)) k++;
      if (k < n && (s.charCodeAt(k) === 34 || s.charCodeAt(k) === 39)) {
        const q = s.charCodeAt(k);
        k++;
        while (k < n && s.charCodeAt(k) !== q) k++;
        if (k >= n) return 0;
        k++;
      } else {
        while (k < n) {
          const d = s.charCodeAt(k);
          if (d === 32 || d === 9 || d === 10 || d === 13 || d === 62 || d === 34 || d === 39 || d === 61 || d === 60 || d === 96) break;
          k++;
        }
      }
      // after a value only whitespace, / or > may follow
      if (k < n) {
        const d = s.charCodeAt(k);
        if (d !== 32 && d !== 9 && d !== 10 && d !== 13 && d !== 47 && d !== 62) return 0;
      }
    }
  }
  return 0;
}

/**
 * Parse an inline link's (destination "title") at s[i] (i points at the
 * '('). Returns { dest, title, next } (next is past the ')') or null.
 * Newlines may appear inside; only spaces/tabs may precede the ')'.
 */
function parseInlineLinkTail(s, i) {
  const n = s.length;
  if (i >= n || s.charCodeAt(i) !== 40) return null;
  let j = i + 1;
  while (j < n && (s.charCodeAt(j) === 32 || s.charCodeAt(j) === 10 || s.charCodeAt(j) === 9)) j++;
  if (j >= n) return null;
  if (s.charCodeAt(j) === 41) return { dest: '', title: null, next: j + 1 };
  const dest = parseLinkDestination(s, j);
  if (!dest) return null;
  j = dest.next;
  while (j < n && (s.charCodeAt(j) === 32 || s.charCodeAt(j) === 10 || s.charCodeAt(j) === 9)) j++;
  if (j >= n) return null;
  let title = null;
  if (s.charCodeAt(j) === 34 || s.charCodeAt(j) === 39 || s.charCodeAt(j) === 40) {
    const t = parseLinkTitle(s, j);
    if (!t) return null;
    title = t.title;
    j = t.next;
    while (j < n && (s.charCodeAt(j) === 32 || s.charCodeAt(j) === 10 || s.charCodeAt(j) === 9)) j++;
  }
  if (j >= n || s.charCodeAt(j) !== 41) return null;
  return { dest: dest.dest, title, next: j + 1 };
}

// Marked's GFM _backpedal, applied to an extended-autolink URL until it
// stops changing. The regex matches a prefix of the URL: runs of
// non-punctuation, balanced (...) pairs, a & that does not start an
// entity at the end, and punctuation runs that are NOT at the very end.
// So a trailing ) or ] is trimmed only when it is the last char; a )
// followed by a non-punctuation char (e.g. ] in https://d.e)] or ( in
// https://d.e](https://f.g) is KEPT, and a ] is part of the URL
// (www.foo.com][missing] links the whole thing). A trailing ; that
// completes an entity is trimmed back to the & by the & alternative.
const backpedalRe = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;
/**
 * The end index of an extended autolink whose candidate URL runs from
 * `start` to `end` (up to whitespace or <). Applies marked's _backpedal
 * until stable and returns the end index of the kept prefix.
 */
function extAutolinkEnd(s, start, end) {
  let url = s.slice(start, end);
  let prev;
  do {
    prev = url;
    const m = backpedalRe.exec(url);
    url = m ? m[0] : '';
  } while (url !== prev);
  return start + url.length;
}

// Marked's link-label content pattern, anchored to the whole label.
// A backtick run in the label must be part of a code span (opening run
// + non-backtick content + closing run, runs of ANY length) that closes
// before the label ends, or a run of 2+ backticks right before the ].
// If a backtick run can only close past the ], the code-span alternative
// spans past it, the label fails, and the link does not form
// ([not a `link](/foo`) stays literal; [issue read two ``small`](...)
// links, because ``small` closes inside the label).
const labelContentRe = /^(?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*?\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*$/;

/**
 * Would the innermost open `[` form a link whose label ends at the first
 * `]` at or after `i`? Read-only predicate mirroring tryLink: a valid
 * inline destination or a defined reference after the `]`, a label whose
 * backticks all close inside it (see labelContentRe), and no link
 * forming inside the label (De rejects a link whose label text contains
 * a link). Returns that `]` index, or -1.
 * Marked tries its link rule at the `[` first and consumes the whole
 * [...](...) before its url rule ever sees the URL inside the label, so
 * an autolink inside a forming link's label never swallows the `](...)`.
 * This parser resolves links at `]`-time, so the autolink scan needs
 * this lookahead: stop at the `]` only when the `[` will form a link
 * there; when it will not (bad destination, undefined reference, or a
 * link inside the label), the `]` belongs to the URL
 * (www.foo.com][missing] links the whole thing).
 */
function bracketLinkClose(s, i, delims, refs) {
  let open = null;
  for (let d = delims.length - 1; d >= 0; d--) {
    if (delims[d].ch === '[' && delims[d].active !== false) { open = delims[d]; break; }
  }
  if (!open || open.tainted) return -1;
  const n = s.length;
  let b = -1;
  for (let k = i; k < n; k++) {
    const c = s.charCodeAt(k);
    if (c === 10) break;
    if (c === 92) { k++; continue; }
    if (c === 93) { b = k; break; }
  }
  if (b === -1) return -1;
  const after = b + 1;
  let destOk = false;
  if (after < n && s.charCodeAt(after) === 40) {
    if (parseInlineLinkTail(s, after)) destOk = true;
    else {
      // a bad inline tail falls back to a shortcut reference on the label
      const key = normalizeLabel(s.slice(open.srcIdx + 1, b));
      destOk = key !== '' && refs.has(key);
    }
  } else if (after < n && s.charCodeAt(after) === 91) {
    let j = after + 1;
    let label = '';
    let ok = false;
    while (j < n) {
      const c = s.charCodeAt(j);
      if (c === 93) { ok = true; j++; break; }
      label += s[j];
      j++;
    }
    if (ok) {
      if (label === '') destOk = true;
      else {
        const key = normalizeLabel(label);
        destOk = key !== '' && label.length <= 999 && refs.has(key);
      }
    }
  } else {
    const key = normalizeLabel(s.slice(open.srcIdx + 1, b));
    destOk = key !== '' && refs.has(key);
  }
  if (!destOk) return -1;
  // The label's backticks must all close inside it (see labelContentRe).
  // A run that can only close past the ] makes the label fail, so the
  // link does not form and a code span / autolink may cross the ].
  const label = s.slice(open.srcIdx + 1, b);
  if (label.indexOf('`') !== -1 && !labelContentRe.test(label)) return -1;
  // linkEmitted: no link may form inside the label. A link inside is a
  // `[` whose own `]` is followed by a valid inline destination or a
  // defined reference (one level is enough for the doc cases).
  for (let q = 0; q < label.length; q++) {
    if (label.charCodeAt(q) !== 91) continue;
    if (q > 0 && label.charCodeAt(q - 1) === 92) continue;
    let r = -1;
    for (let k = q + 1; k < label.length; k++) {
      if (label.charCodeAt(k) === 92) { k++; continue; }
      if (label.charCodeAt(k) === 93) { r = k; break; }
    }
    if (r === -1) continue;
    const a2 = r + 1;
    if (a2 < label.length && label.charCodeAt(a2) === 40) {
      if (parseInlineLinkTail(label, a2)) return -1;
    } else if (a2 < label.length && label.charCodeAt(a2) === 91) {
      let j = a2 + 1;
      let l2 = '';
      let ok2 = false;
      while (j < label.length) {
        if (label.charCodeAt(j) === 93) { ok2 = true; break; }
        l2 += label[j];
        j++;
      }
      if (ok2) {
        if (l2 === '') return -1;
        const key2 = normalizeLabel(l2);
        if (key2 !== '' && l2.length <= 999 && refs.has(key2)) return -1;
      }
    } else {
      const key2 = normalizeLabel(label.slice(q + 1, r));
      if (key2 !== '' && refs.has(key2)) return -1;
    }
  }
  return b;
}

/**
 * A GFM extended autolink starting at s[i]: www. + domain, scheme:... or
 * an email address. Returns { href, text, email, next } or null. The caller
 * has checked that the preceding character allows an autolink here.
 */
function extAutolink(s, i, delims, refs) {
  const n = s.length;
  // No blanket suppression here: an autolink inside a link's text is
  // suppressed only when the enclosing link actually FORMS (unwrapped
  // in tryLink). An unmatched [ that never forms a link leaves the URL
  // autolinked ([x https://a.b. because][missing] links the URL).
  // www. + domain
  if (s.startsWith('www.', i)) {
    let j = i + 4;
    let k = j;
    // Marked's url regex after the domain is [^\s<]*: it does NOT stop
    // at ] (www.foo.com][missing] links the whole thing). But when the
    // enclosing [ will form a link, the URL is inside its label and must
    // stop at the label's ] (marked consumes the link first). Cap the
    // scan at that ] only; otherwise the _backpedal decides.
    while (k < n) {
      const c = s.charCodeAt(k);
      if (c <= 32 || c === 60) break;
      k++;
    }
    const bClose = bracketLinkClose(s, i, delims, refs);
    if (bClose !== -1 && bClose < k) k = bClose;
    // the domain must hold a dot with a letter after it
    const dom = s.slice(j, k);
    if (!/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/.test(dom)) return null;
    const e = extAutolinkEnd(s, i, k);
    if (e <= i + 4) return null;
    return { href: 'http://' + s.slice(i, e), text: s.slice(i, e), email: false, next: e };
  }
  // scheme: or email — scan a short way for : or @
  const c0 = s.charCodeAt(i);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122) || (c0 >= 48 && c0 <= 57))) return null;
  // scheme: look for ':' within 32 chars
  let j = i;
  while (j < n && j < i + 33) {
    const c = s.charCodeAt(j);
    if (c === 58) {
      const sl = schemeAt(s, i);
      if (sl > 0 && j === i + sl) {
        // scheme://... is a full URL (whole path included); scheme:email
        // is an email with at most one path segment (gfm-635:
        // xmpp:foo@bar.baz/txt/bin links only .../txt).
        if (s.startsWith('//', j + 1)) {
          let k = j + 1;
          // Same as the www. scan: [^\s<]*, capped only when the
          // enclosing [ will form a link (see bracketLinkClose).
          while (k < n) {
            const d = s.charCodeAt(k);
            if (d <= 32 || d === 60) break;
            k++;
          }
          const bClose = bracketLinkClose(s, i, delims, refs);
          if (bClose !== -1 && bClose < k) k = bClose;
          if (k === j + 1) return null;
          const e = extAutolinkEnd(s, i, k);
          return { href: s.slice(i, e), text: s.slice(i, e), email: false, next: e };
        }
        let k = j + 1;
        let at = -1;
        while (k < n) {
          const d = s.charCodeAt(k);
          if (d === 64) {
            if (at !== -1) return null;
            at = k;
          } else if (d === 47 || d <= 32 || d === 60 || d === 62) break;
          else if (!(isAlnum(d) || d === 46 || d === 45 || d === 95 || d === 43)) return null;
          k++;
        }
        if (at === -1) return null;
        // a trailing . is not part of the email (mailto:a.b-c_d@a.b.
        // links the email, the . is outside); strip it before the
        // domain-dot check below.
        while (k > j + 1 && s.charCodeAt(k - 1) === 46) k--;
        const inner = s.slice(j + 1, k);
        // the extended-autolink email domain must contain a dot:
        // hello@mail is not an autolink (gfm-631).
        if (!/^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9])?)+$/.test(inner)) return null;
        let e = k;
        if (e < n && s.charCodeAt(e) === 47) {
          e++;
          while (e < n) {
            const d = s.charCodeAt(e);
            if (d <= 32 || d === 60 || d === 62 || d === 47 || d === 63 || d === 35) break;
            e++;
          }
          if (e === k + 1) e = k;
        }
        const end = extAutolinkEnd(s, i, e);
        // boundary: a word char or email-local punctuation right after
        // the email means the token is not a valid email at all (the
        // match must end at a word boundary): a.b-c_d@a.b_ and
        // hello@mail+xyz.example do not link (gfm-631/632). A / ? or #
        // is a URL separator and is fine.
        if (end < n) {
          const d = s.charCodeAt(end);
          if (isWordChar(d) || d === 33 || d === 36 || d === 37 || d === 38 || d === 39 || d === 42 || d === 43 || d === 61 || d === 94 || d === 96 || d === 123 || d === 124 || d === 125 || d === 126) return null;
        }
        return { href: s.slice(i, end), text: s.slice(i, end), email: false, next: end };
      }
      return null;
    }
    if (c === 64) break; // may be an email
    if (!(isAlnum(c) || c === 46 || c === 45 || c === 95 || c === 43)) return null;
    j++;
  }
  // email: local@domain
  let at = -1;
  let k = i;
  while (k < n) {
    const c = s.charCodeAt(k);
    if (c === 64) {
      if (at !== -1) return null;
      at = k;
    } else if (at !== -1 && !(isAlnum(c) || c === 46 || c === 45 || (c === 95 && k + 1 < n && isAlnum(s.charCodeAt(k + 1))))) {
      // in the domain part letters, digits, . and - belong to the
      // email, and _ belongs to it only when followed by an alphanumeric
      // (foo@bar.baz_qux links as one address); a trailing _ is not
      // part of the address. A / (or ? # etc.) ends it (foo@bar.baz/txt
      // links only the email, /txt is literal text).
      break;
    } else if (c === 32 || c === 10 || c === 60 || c === 62 || c === 40 || c === 41 || c === 91 || c === 93 || c === 123 || c === 125 || c === 34 || c === 39 || c === 59 || c === 44 || c === 58) break;
    else if (!(isAlnum(c) || c === 46 || c === 95 || c === 45 || c === 43 || c === 33 || c === 35 || c === 36 || c === 37 || c === 38 || c === 42 || c === 47 || c === 61 || c === 63 || c === 94 || c === 96 || c === 124 || c === 126)) return null;
    k++;
  }
  if (at === -1) return null;
  // a _ immediately after the address invalidates it (gfm-632:
  // a.b-c_d@a.b_ does not link) — unless it is an emphasis closer,
  // i.e. an unmatched _ opener is open in the current scope, in which
  // case the address links and the _ closes the emphasis
  // (_a b@c.d_ links b@c.d).
  if (k < n && s.charCodeAt(k) === 95) {
    let hasUnderscoreOpener = false;
    if (delims) {
      for (const d of delims) {
        if (d.ch === '_' && d.canOpen) { hasUnderscoreOpener = true; break; }
      }
    }
    if (!hasUnderscoreOpener) return null;
  }
  const e = extAutolinkEnd(s, i, k);
  const inner = s.slice(i, e);
  // the extended-autolink email domain must contain a dot:
  // hello@mail is not an autolink (gfm-631). A _ may appear inside a
  // domain segment (foo@bar.baz_qux links) but the segment must still
  // end with an alphanumeric, so a trailing _ (a.b-c_d@a.b_) does not
  // link (gfm-632).
  if (!/^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9])?)+$/.test(inner)) return null;
  // No boundary check: marked links the email whatever follows it (a
  // trailing * + ! ? / ~ etc. is literal text after the link, not part
  // of it — verified by probing; the domain scan + regex above already
  // ensure the address itself is well-formed).
  return { href: 'mailto:' + inner, text: inner, email: true, next: e };
}

/** Plain text of inline nodes (for reference labels and image alt). */
function plainText(nodes) {
  let out = '';
  for (const nd of nodes) {
    if (nd.t === 'text') out += nd.s;
    else if (nd.t === 'code') out += nd.s;
    else if (nd.t === 'html') out += nd.s;
    else if (nd.t === 'br') out += '\n';
    else if (nd.t === 'em' || nd.t === 'strong' || nd.t === 'del' || nd.t === 'link' || nd.t === 'img') out += plainText(nd.c || []);
    else if (nd.t === 'root') out += plainText(nd.c);
  }
  return out;
}

/** The innermost link or image ancestor of a node, or null (root scope). */
function linkScope(nd) {
  let p = nd.parent;
  while (p) {
    if (p.t === 'link' || p.t === 'img') return p;
    p = p.parent;
  }
  return null;
}

/**
 * Tokenize inline source into a node tree, forming links as ] is met and
 * resolving emphasis afterwards. Returns the root node.
 */
function parseInline(src, refs) {
  const root = { t: 'root', c: [], parent: null };
  const delims = [];
  const n = src.length;
  let i = 0;
  let textBuf = '';

  function pushNode(nd) {
    nd.parent = root;
    root.c.push(nd);
    return nd;
  }
  function flushText() {
    if (textBuf.length > 0) {
      pushNode({ t: 'text', s: textBuf });
      textBuf = '';
    }
  }

  /**
   * Try to form a link or image at the ] at src[i]. Returns the index just
   * past the link, or -1 when no link forms (the opener is deactivated).
   */
  function tryLink(i) {
    let openerIdx = -1;
    for (let k = delims.length - 1; k >= 0; k--) {
      if (delims[k].ch === '[' && delims[k].active) {
        openerIdx = k;
        break;
      }
    }
    if (openerIdx === -1) return -1;
    const opener = delims[openerIdx];
    if (opener.tainted) {
      opener.active = false;
      return -1;
    }
    // Deactivate the emphasis delimiters inside this link's text: when
    // an inline [...](...) link fails, marked leaves its inner _ * ~
    // literal too ([a _b_](not a url) stays "[a _b_](not a url)", no
    // emphasis). A failed reference link does NOT suppress them
    // ([a _b_][missing] still emphasises b), so this is only called
    // for inline-link failures.
    const killInnerEmphasis = () => {
      const opNode = opener.node;
      let opPos = -1;
      for (let k = 0; k < root.c.length; k++) {
        if (root.c[k] === opNode) { opPos = k; break; }
      }
      if (opPos === -1) return;
      const textSet = new Set(root.c.slice(opPos + 1));
      for (const d of delims) {
        if ((d.ch === '*' || d.ch === '_' || d.ch === '~') && textSet.has(d.node)) {
          d.active = false;
        }
      }
    };
    // marked quirk (findClosingBracket): a code span inside the link
    // text whose content holds a backtick, followed by more text before
    // the ], prevents the link from forming ([a `` b ` c `` d](...) stays
    // literal, but [a `` b ` c ``](...) — code span directly before ] —
    // links, and a span with no inner backtick links too).
    const rawText = src.slice(opener.srcIdx + 1, i);
    let p = 0;
    while (p < rawText.length) {
      if (rawText.charCodeAt(p) === 96) {
        let run = 0;
        while (p + run < rawText.length && rawText.charCodeAt(p + run) === 96) run++;
        let q = p + run;
        let found = -1;
        while (q < rawText.length) {
          if (rawText.charCodeAt(q) === 96) {
            let run2 = 0;
            while (q + run2 < rawText.length && rawText.charCodeAt(q + run2) === 96) run2++;
            if (run2 === run) { found = q; break; }
            q += run2;
          } else {
            q++;
          }
        }
        if (found !== -1) {
          const inner = rawText.slice(p + run, found);
          if (inner.indexOf('`') !== -1 && found + run < rawText.length) {
            opener.active = false;
            killInnerEmphasis();
            return -1;
          }
          p = found + run;
        } else {
          p += run;
        }
      } else {
        p++;
      }
    }
    const after = i + 1;
    let dest = null;
    let title = null;
    let next = -1;
    let triedInlineBad = false;
    if (after < n && src.charCodeAt(after) === 40) {
      const tail = parseInlineLinkTail(src, after);
      if (!tail) {
        // not a valid inline link: fall back to a shortcut reference, so
        // "[foo](not a link)" with a [foo] definition links foo and leaves
        // "(not a link)" as literal text
        dest = null;
        next = i + 1;
        triedInlineBad = true;
      } else {
        dest = tail.dest;
        title = tail.title;
        next = tail.next;
      }
    } else if (after < n && src.charCodeAt(after) === 91) {
      // full reference [label] or collapsed []
      let j = after + 1;
      let label = '';
      let ok = false;
      while (j < n) {
        const c = src.charCodeAt(j);
        if (c === 93) {
          ok = true;
          j++;
          break;
        }
        // the label is matched raw: a backslash escape in it is NOT
        // resolved, so [foo\!] does not match a [foo!] definition
        label += src[j];
        j++;
      }
      if (!ok) {
        opener.active = false;
        return -1;
      }
      next = j;
      if (label === '') {
        // collapsed: the label is the link text (filled in below)
        dest = null;
      } else {
        const key = normalizeLabel(label);
        if (key === '' || label.length > 999) {
          opener.active = false;
          return -1;
        }
        const ref = refs.get(key);
        if (!ref) {
          opener.active = false;
          return -1;
        }
        dest = ref.dest;
        title = ref.title;
      }
    } else {
      // shortcut reference: the label is the link text
      dest = null;
      next = i + 1;
    }
    // The link text is the nodes after the opener's text node in root.c.
    const opNode = opener.node;
    let opPos = -1;
    for (let k = 0; k < root.c.length; k++) {
      if (root.c[k] === opNode) {
        opPos = k;
        break;
      }
    }
    if (opPos === -1) {
      opener.active = false;
      return -1;
    }
    const textNodes = root.c.slice(opPos + 1);
    if (dest === null) {
      // shortcut or collapsed: resolve the label from the RAW source text
      // of the link (between [ and ]), not from the parsed text nodes:
      // backslash escapes in the label are not resolved, so [foo\!] does
      // not match a [foo!] definition
      const label = src.slice(opener.srcIdx + 1, i);
      const key = normalizeLabel(label);
      const ref = key === '' ? undefined : refs.get(key);
      if (!ref) {
        opener.active = false;
        if (triedInlineBad) killInnerEmphasis();
        return -1;
      }
      dest = ref.dest;
      title = ref.title;
    }
    const href = cleanHref(dest);
    if (href === null) {
      opener.active = false;
      return -1;
    }
    // A link may not contain another link: unwrap any extended/angle
    // autolink inside the link text back to plain text (its atext).
    // This runs only when the enclosing link FORMS; when it fails, the
    // autolink stands (see extAutolink).
    const unwrapAuto = (nodes) => {
      for (let k = 0; k < nodes.length; k++) {
        const nd = nodes[k];
        if (nd.t === 'link' && nd.auto) {
          const txt = nd.c && nd.c[0] ? nd.c[0].s : '';
          nodes[k] = { t: 'text', s: txt, parent: nd.parent };
        } else if (nd.c) {
          unwrapAuto(nd.c);
        }
      }
    };
    unwrapAuto(textNodes);
    // Build the link or image node, moving the text nodes into it.
    let node;
    if (opener.isImage) {
      node = { t: 'img', src: href, title, c: textNodes, parent: root };
    } else {
      node = { t: 'link', href, title, c: textNodes, parent: root };
    }
    for (const nd of textNodes) nd.parent = node;
    // remove the opener's '[' (and the '!' before it for images)
    root.c.length = opPos;
    if (opener.isImage && root.c.length > 0) {
      const prev = root.c[root.c.length - 1];
      if (prev.t === 'text' && prev.s.length > 0 && prev.s.charCodeAt(prev.s.length - 1) === 33) {
        prev.s = prev.s.slice(0, -1);
        if (prev.s === '') root.c.pop();
      }
    }
    root.c.push(node);
    // Marked tokenizes link text with inLink forced on and restores the
    // flag afterwards: tags inside the link text must not leak their
    // inLink effect to the rest of the document.
    inLinkDoc = opener.linkState;
    // Drop the opener and any [ openers inside the link text from the
    // delimiter stack, but KEEP the emphasis delimiters (* _ ~) that were
    // inside the link text: they can still pair within the link, so
    // [a *b* c](/u) must emphasize b. When a LINK forms, taint every [
    // still open (a link cannot contain another link). When an IMAGE
    // forms, do not taint: a link may contain an image.
    let w = 0;
    for (let k = 0; k < delims.length; k++) {
      const d = delims[k];
      if (k >= openerIdx && d.ch === '[') continue;
      delims[w++] = d;
    }
    delims.length = w;
    if (!opener.isImage) {
      // taint only outer LINK openers (a link cannot contain another
      // link); an outer IMAGE opener is not tainted — an image may
      // contain a link in its alt text, which renders as plain text
      // (cm-575: ![foo [bar](/url)](/url2) forms the image).
      for (const d of delims) {
        if (d.ch === '[' && !d.isImage) d.tainted = true;
      }
    }
    return next;
  }

  while (i < n) {
    const c = src.charCodeAt(i);
    if (c === 92) {
      // backslash escape, or a hard break before a newline
      if (i + 1 < n) {
        const d = src.charCodeAt(i + 1);
        if (d === 10) {
          flushText();
          pushNode({ t: 'br' });
          i += 2;
          // a hard break eats the next line's leading spaces/tabs
          while (i < n && (src.charCodeAt(i) === 32 || src.charCodeAt(i) === 9)) i++;
          continue;
        }
        if (isPunct(d)) {
          if (d === 38) {
            // an escaped & is literal, never the start of an entity
            flushText();
            pushNode({ t: 'text', s: '&', escAll: true });
          } else {
            textBuf += src[i + 1];
          }
          i += 2;
          continue;
        }
      }
      textBuf += '\\';
      i++;
      continue;
    }
    if (c === 96) {
      // code span
      let j = i;
      while (j < n && src.charCodeAt(j) === 96) j++;
      const runLen = j - i;
      // A code span inside a link label must not close past the label's
      // ] (marked re-tokenizes the label in isolation, so a span there
      // can only close inside it). Cap the scan at the ] where the
      // enclosing [ will form a link; when it will not form there is no
      // cap (see bracketLinkClose).
      const cap = bracketLinkClose(src, i, delims, refs);
      let k = j;
      let found = -1;
      while (k < n && (cap === -1 || k < cap)) {
        if (src.charCodeAt(k) === 96) {
          let m = k;
          while (m < n && src.charCodeAt(m) === 96) m++;
          if (m - k === runLen) {
            found = k;
            break;
          }
          k = m;
        } else k++;
      }
      if (found === -1) {
        textBuf += src.slice(i, j);
        i = j;
        continue;
      }
      let content = src.slice(j, found).replace(/\n/g, ' ');
      if (content.length >= 2 && content.charCodeAt(0) === 32 && content.charCodeAt(content.length - 1) === 32 && !/^[ ]+$/.test(content)) {
        content = content.slice(1, -1);
      }
      flushText();
      pushNode({ t: 'code', s: content });
      i = found + runLen;
      continue;
    }
    if (c === 60) {
      // autolink <...> or raw HTML
      const al = parseAutolink(src, i);
      if (al) {
        const url = al.email ? 'mailto:' + al.url : al.url;
        let href = null;
        try {
          href = escAll(encodeUrl(url));
        } catch {
          href = null;
        }
        if (href !== null) {
          flushText();
          const linkNode = pushNode({ t: 'link', href, title: null, c: [{ t: 'atext', s: al.url, parent: null }] });
          linkNode.c[0].parent = linkNode;
          i = al.next;
          continue;
        }
        // a lone-surrogate URL is not a link: fall through to raw HTML/text
      }
      const hl = inlineHtmlLen(src, i);
      if (hl > 0) {
        flushText();
        pushNode({ t: 'html', s: src.slice(i, i + hl) });
        // marked's tag tokenizer: "<a " sets inLink, "</a>" clears it;
        // the flag persists across blocks (see inLinkDoc).
        const tag = src.slice(i, i + hl);
        if (!inLinkDoc && /^<a /i.test(tag)) inLinkDoc = true;
        else if (inLinkDoc && /^<\/a>/i.test(tag)) inLinkDoc = false;
        i += hl;
        continue;
      }
      textBuf += '<';
      i++;
      continue;
    }
    if (c === 42 || c === 95 || c === 126) {
      // emphasis / strikethrough delimiter run
      let j = i;
      while (j < n && src.charCodeAt(j) === c) j++;
      const runLen = j - i;
      const before = i > 0 ? src.charCodeAt(i - 1) : -1;
      const after = j < n ? src.charCodeAt(j) : -1;
      const beforeIsSpace = before === -1 || isUniSpace(before);
      const afterIsSpace = after === -1 || isUniSpace(after);
      const beforeIsPunct = before !== -1 && isUniPunct(before);
      const afterIsPunct = after !== -1 && isUniPunct(after);
      const leftFlanking = !afterIsSpace && (!afterIsPunct || beforeIsSpace || beforeIsPunct);
      const rightFlanking = !beforeIsSpace && (!beforeIsPunct || afterIsSpace || afterIsPunct);
      let canOpen, canClose;
      if (c === 95) {
        canOpen = leftFlanking && (!rightFlanking || beforeIsPunct);
        canClose = rightFlanking && (!leftFlanking || afterIsPunct);
      } else {
        canOpen = leftFlanking;
        canClose = rightFlanking;
      }
      flushText();
      const textNode = pushNode({ t: 'text', s: src.slice(i, j) });
      // a single ~ is a strikethrough delimiter too (marked renders
      // ~a~ as <del>a</del>, not just ~~a~~), but a run of 3+ tildes is
      // literal text (gfm-493: ~~~not~~~ does not strike).
      if (!(c === 126 && runLen > 2)) {
        delims.push({ ch: String.fromCharCode(c), node: textNode, start: 0, count: runLen, orig: runLen, canOpen, canClose, active: true, beforeCh: before, afterCh: after, srcIdx: i });
      }
      i = j;
      continue;
    }
    if (c === 91) {
      flushText();
      const textNode = pushNode({ t: 'text', s: '[' });
      delims.push({ ch: '[', node: textNode, start: 0, active: true, isImage: false, tainted: false, srcIdx: i, linkState: inLinkDoc });
      i++;
      continue;
    }
    if (c === 33) {
      if (i + 1 < n && src.charCodeAt(i + 1) === 91) {
        textBuf += '!';
        flushText();
        const textNode = pushNode({ t: 'text', s: '[' });
        delims.push({ ch: '[', node: textNode, start: 0, active: true, isImage: true, tainted: false, srcIdx: i + 1, linkState: inLinkDoc });
        i += 2;
        continue;
      }
      textBuf += '!';
      i++;
      continue;
    }
    if (c === 93) {
      flushText();
      const next = tryLink(i);
      if (next !== -1) {
        i = next;
        continue;
      }
      textBuf += ']';
      i++;
      continue;
    }
    if (c === 10) {
      // soft break, or a hard break after two or more spaces
      let trailing = 0;
      while (trailing < textBuf.length && textBuf.charCodeAt(textBuf.length - 1 - trailing) === 32) trailing++;
      if (trailing >= 2) {
        textBuf = textBuf.slice(0, textBuf.length - trailing);
        flushText();
        pushNode({ t: 'br' });
        i++;
        // a hard break eats the next line's leading spaces/tabs
        while (i < n && (src.charCodeAt(i) === 32 || src.charCodeAt(i) === 9)) i++;
      } else {
        textBuf += '\n';
        i++;
      }
      continue;
    }
    // an extended autolink may start here (preceded by start, space or * _ ~ ( <),
    // and only while not inside a link: marked never tries its url rule
    // while its inLink state is set, e.g. after an unclosed <a ...> tag)
    if (!inLinkDoc && (c === 119 || ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57)))) {
      const prev = i > 0 ? src.charCodeAt(i - 1) : -1;
      if (prev === -1 || isSpace(prev) || prev === 42 || prev === 95 || prev === 126 || prev === 40 || prev === 60) {
        const al = extAutolink(src, i, delims, refs);
        if (al) {
          let href = null;
          try {
            href = escAll(encodeUrl(al.href));
          } catch {
            href = null;
          }
          if (href !== null) {
            flushText();
            const linkNode = pushNode({ t: 'link', href, title: null, auto: true, c: [{ t: 'atext', s: al.text, parent: null }] });
            linkNode.c[0].parent = linkNode;
            i = al.next;
            continue;
          }
        }
      }
    }
    textBuf += src[i];
    i++;
  }
  flushText();
  processEmphasis(root, delims, src);
  return root;
}

/**
 * Resolve emphasis / strikethrough delimiters. For each closer (in order),
 * pair it with the nearest earlier opener of the same character in the same
 * link scope. Marked's run-splitting deviates from the CommonMark odd-match
 * rule; the skip predicate below was fitted empirically against marked
 * 18.1.3 (probe behaviour only, never its code) and validated on the full
 * practice set plus a 73-case curated battery:
 *  - odd sum: skip when the opener can close or the closer can open, the
 *    closer run is at most 2 long, and the opener run is at most 2 long
 *    or the opener can close (so a longer closer run pairs, e.g. cm-415).
 *  - even sum: skip a would-be strong pairing when the closer cannot open,
 *    the closer is the last same-char delimiter, and an earlier same-char
 *    opener with exactly 1 delimiter left is available (the closer then
 *    forms an em with that earlier opener instead, e.g. `*foo**bar**`).
 * A delimiter node is its run as a text node; using k delimiters removes
 * k characters from the start of an opener run and the end of a closer run.
 * Nodes between the pair move into the new em/strong/del node. A delimiter
 * inside an already-formed emphasis node is sealed there: pairing requires
 * the same parent container. When a live same-char delimiter sits between
 * the opener and the closer, the closer's leftover delimiters render
 * INSIDE the new node (marked puts them there, e.g. `*foo**bar**` gives
 * `<em>foo**bar*</em>`); otherwise they render after it.
 */
/** Whether opener `op` (delims[oi]) must be skipped for closer `closer` (delims[ci]). */
function emSkip(op, closer, delims, oi, ci) {
  const sum = op.count + closer.count;
  if (sum % 2 === 1) {
    return (op.canClose || closer.canOpen) && closer.count <= 2 && (op.count <= 2 || op.canClose);
  }
  // Second branch REMOVED 2026-11-16 (v3): the backward scan for a live
  // single opener before a ** pair blocked valid strongs — *a **b**,
  // *a **b**c* **d**, *a *b* **c** all stayed literal in mine while
  // marked forms the strong and leaves the single * literal. Marked's
  // emStrong scans forward from the ** opener, so a single * before it
  // cannot block the pair.
  return false;
}

/**
 * The delimiter run skipped by marked's closer-regex leading alternative:
 * a single delimiter inside a double-delimiter span of the other char (a
 * * inside __...__ for a * opener; a _ inside **...** for a _ opener).
 * The span must start at the scan start: the opening double run is the
 * first run of the other char after the opener, the skipped run is
 * the immediate next run of either char, and the closing double run
 * is the immediate next after that.
 * Only one such skip per scan. Returns the delim index or -1.
 */
function emSkipRun(op, delims, oi, scope, src) {
  const other = op.ch === '*' ? '_' : '*';
  let state = 0;
  let cand = -1;
  for (let j = oi + 1; j < delims.length; j++) {
    const d = delims[j];
    if (d.ch !== '*' && d.ch !== '_') continue;
    if (linkScope(d.node) !== scope) continue;
    if (isMasked(d, src)) continue;
    const cnt = d.orig !== undefined ? d.orig : d.count;
    if (state === 0) {
      if (d.ch === other && cnt >= 2) state = 1;
      else return -1;
    } else if (state === 1) {
      if (d.ch === op.ch && cnt === 1) { cand = j; state = 2; }
      else return -1;
    } else {
      if (d.ch === other && cnt >= 2) return cand;
      return -1;
    }
  }
  return -1;
}

/**
 * Would marked's forward emStrong scan from opener `op` pair with closer
 * `closer`? Simulates marked's m/f/rule-of-3 accounting over the delimiter
 * runs after `op` (same char, same link scope, ORIGINAL lengths — the scan
 * runs over the raw text, before any inner pairing resolves, so consumed
 * runs still count). An open-only run adds its length to m, a close-only
 * run (or a "both" run that passes the rule of 3) subtracts its length
 * and pairs when m drops to 0 or below, and a "both" run failing the rule
 * of 3 adds its length to f instead. One single-delimiter run inside a
 * double-delimiter span of the other char is invisible to the scan (see
 * emSkipRun). Marked retries emStrong at every position inside the opener
 * run (the text rule consumes one delimiter at a time), so the scan is
 * tried from each start position p = 0..L-1 in turn: the first p that
 * pairs decides, and only a p with no pairing advances to the next.
 * The scan's first pairing wins:
 *  - no pairing at any p: the opener is literal in marked — forbid.
 *  - first pairing is `closer`: allow.
 *  - first pairing is an earlier run: marked pairs the opener there, so
 *    this later pairing is not what marked does — forbid.
 *  - first pairing is a later run: this pairing is the inner one, formed
 *    when marked re-tokenizes the outer pair's text — allow only when the
 *    opener has delimiters left for both pairings (cm-408: `__foo_ bar_`).
 * Only for * and _ (the ~ rule is a plain length match). An extra gate on
 * top of emSkip.
 */
// Masking for marked's emStrong/del forward scan: marked masks its inline
// text before the scan, hiding code spans, inline links and HTML tags.
// Its code-span detection does NOT respect link-label boundaries, so a
// dangling backtick run (one that cannot close inside its link label,
// e.g. the single ` after ``b` in [a ``b`](c)) pairs with a later
// same-length run and hides everything between them from the scan —
// including __...__ delimiters ([a ``b`](c) ... __issues most__ ...
// `__init__` leaves the __ literal). Faithful simulation of marked's
// mask pipeline (patterns read from vendored marked.esm.js, re-derived
// here, never copied): (1) anyPunctuationOutsideCode neutralises inner
// backticks of code spans and escaped punctuation; (2) blockSkip hides
// inline links (label backticks must pair equal-length inside the
// label), code spans (equal-length runs, opener not preceded by a
// backtick) and HTML tags. The reflink step is skipped: reference-link
// labels are hidden by this parser's linkScope whenever the link forms,
// which is exactly the set marked's reflink masking hides. All three
// replacements preserve length, so spans map 1:1 onto the source.
// Returns [start, end) spans of masked text, cached per source string.
const MASK_CODE_RE = /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu;
// blockSkip, built from its three alternatives so the backtick-run
// backreferences stay readable: an inline link (label backticks must
// pair equal-length inside the label), a code span (equal-length runs,
// opener not preceded by a backtick), an HTML tag.
const MASK_BLOCKSKIP_RE = new RegExp(
  '\\[' + '(?:' + '[^\\[\\]`]' + '|' + '(?<a>`+)' + '[^`]+' + '\\k<a>' + '(?!`)' + ')*?' + '\\]' + '\\(' + '(?:' + '\\\\[\\s\\S]' + '|' + '[^\\\\\\(\\)]' + '|' + '\\((?:\\\\[\\s\\S]|[^\\\\\\(\\)])*\\)' + ')*' + '\\)'
  + '|' + '(?<!`)()' + '(?<b>`+)' + '[^`]+' + '\\k<b>' + '(?!`)'
  + '|' + '<(?! )[^<>]*?>',
  'g');
let maskSrc = null;
let maskSpans = null;
function getMaskSpans(src) {
  if (src === maskSrc) return maskSpans;
  maskSrc = src;
  const step2 = src.replace(MASK_CODE_RE, (n, s, r) =>
    r ? '+'.repeat(n.length)
      : s ? s + n.slice(s.length, -s.length).replace(/`/g, '+') + s
      : n);
  const spans = [];
  MASK_BLOCKSKIP_RE.lastIndex = 0;
  let m;
  while ((m = MASK_BLOCKSKIP_RE.exec(step2)) !== null) {
    spans.push([m.index, m.index + m[0].length]);
    if (m[0].length === 0) MASK_BLOCKSKIP_RE.lastIndex++;
  }
  maskSpans = spans;
  return spans;
}
function inMaskSpan(src, idx) {
  const spans = getMaskSpans(src);
  for (let q = 0; q < spans.length; q++) {
    if (idx >= spans[q][0] && idx < spans[q][1]) return true;
    if (spans[q][0] > idx) break;
  }
  return false;
}
/** True when delimiter d is hidden from marked's scan: root-scope and
 *  inside a masked span. Link-scoped delimiters are not masked here —
 *  marked re-tokenises link text separately with its own mask. */
function isMasked(d, src) {
  return linkScope(d.node) === null && inMaskSpan(src, d.srcIdx);
}

function emForwardPairs(op, closer, delims, oi, ci, src) {
  if (op.ch !== '*' && op.ch !== '_') return true;
  // A delimiter hidden by marked's mask never pairs: the scan runs
  // over masked text, so a masked opener or closer is invisible.
  if (isMasked(op, src) || isMasked(closer, src)) return false;
  const L = op.orig !== undefined ? op.orig : op.count;
  const scope = linkScope(op.node);
  const afterNonSpace = op.afterCh !== -1 && !isUniSpace(op.afterCh);
  const y = afterNonSpace ? L : L - 1;
  const skipIdx = emSkipRun(op, delims, oi, scope, src);
  if (ci === skipIdx) return false;
  const chCode = op.ch.charCodeAt(0);
  for (let p = 0; p < L; p++) {
    const k = afterNonSpace ? (L - p) : (L - p - 1);
    if (k <= 0) break;
    // o: the char before this start position is the delimiter itself
    // (true for p > 0: the text rule just consumed one delimiter char).
    const o = p > 0 || op.beforeCh === chCode;
    // R: for p = 0 from the chars around the run; for p > 0 the char
    // before the start is the delimiter, so R is just "after is punct".
    const R = p === 0
      ? (op.beforeCh !== -1 && !isUniSpace(op.beforeCh) &&
        (isUniPunct(op.afterCh) || (op.ch === '*' && !isUniPunct(op.beforeCh))))
      : isUniPunct(op.afterCh);
    let m = k;
    let f = 0;
    let paired = -1;
    let pairedBPrime = 0;
    for (let j = oi + 1; j < delims.length; j++) {
      if (j === skipIdx) continue;
      const d = delims[j];
      if (d.ch !== op.ch) continue;
      if (linkScope(d.node) !== scope) continue;
      if (isMasked(d, src)) continue;
      const cnt = d.orig !== undefined ? d.orig : d.count;
      if (!d.canOpen && !d.canClose) continue;
      if (d.canOpen && !d.canClose) { m += cnt; continue; }
      const both = d.canOpen && d.canClose;
      if (both || R) {
        if (both && o) { paired = -2; break; }
        if (y % 3 !== 0 && (y + cnt) % 3 === 0) { f += cnt; continue; }
      }
      m -= cnt;
      if (m > 0) continue;
      paired = j;
      pairedBPrime = Math.min(cnt, cnt + m + f);
      break;
    }
    if (paired === -2 || paired === -1) continue;
    if (paired === ci) {
      // Return the use for this pairing (marked's min(k,b)%2 rule):
      // odd -> em (1), even -> strong (2). Callers use it to know
      // whether the closer is fully consumed by a strong.
      const useHere = (Math.min(k, pairedBPrime) % 2 === 1) ? 1 : 2;
      return useHere;
    }
    if (paired < ci) return false;
    const useOuter = (Math.min(k, pairedBPrime) % 2 === 1) ? 1 : 2;
    const useInner = (op.count >= 2 && closer.count >= 2) ? 2 : 1;
    return op.count >= useInner + useOuter;
  }
  return false;
}


function processEmphasis(root, delims, src) {
  let ci = 0;
  while (ci < delims.length) {
    const closer = delims[ci];
    if (closer.ch === '[' || !closer.active || !closer.canClose || closer.count === 0 || isMasked(closer, src)) { ci++; continue; }
    let oi = -1;
    for (let k = ci - 1; k >= 0; k--) {
      const op = delims[k];
      if (op.ch !== closer.ch || !op.active || !op.canOpen || op.count === 0 || isMasked(op, src)) continue;
      if (linkScope(op.node) !== linkScope(closer.node)) continue;
      if (op.node.parent !== closer.node.parent) continue;
      if (emSkip(op, closer, delims, k, ci)) continue;
      if (!emForwardPairs(op, closer, delims, k, ci, src)) continue;
      // A single `*` opener must not steal a `**` closer from an
      // earlier `**` opener when that earlier opener pairs with it as
      // a STRONG (use 2) and fully consumes the 2-count closer:
      // marked tokenises left to right, so the leftmost `**` opener
      // forms the strong first and the inner `*` stays literal
      // (doc-11: **a *b **c**d* e** -> the outer strong forms).
      // If the earlier opener only pairs as an em (use 1, e.g. via
      // p=1), it leaves a delimiter for the inner em — do not skip
      // (**a *b **c** d** -> nested ems, not the outer strong).
      if (op.count === 1 && closer.count === 2) {
        let stolen = false;
        for (let j = k - 1; j >= 0; j--) {
          const eo = delims[j];
          if (eo.ch !== closer.ch || !eo.active || !eo.canOpen || eo.count < 2 || isMasked(eo, src)) continue;
          if (linkScope(eo.node) !== linkScope(closer.node)) continue;
          if (eo.node.parent !== closer.node.parent) continue;
          if (emForwardPairs(eo, closer, delims, j, ci, src) === 2) { stolen = true; break; }
        }
        if (stolen) continue;
      }
      oi = k;
      break;
    }
    if (oi === -1) { ci++; continue; }
    const opener = delims[oi];
    const use = (opener.count >= 2 && closer.count >= 2) ? 2 : 1;
    const tag = closer.ch === '~' ? 'del' : (use === 2 ? 'strong' : 'em');
    const parent = opener.node.parent;
    const oi2 = parent.c.indexOf(opener.node);
    const ci2 = parent.c.indexOf(closer.node);
    opener.node.s = opener.node.s.slice(use);
    opener.count -= use;
    closer.node.s = closer.node.s.slice(0, closer.node.s.length - use);
    closer.count -= use;
    const between = parent.c.slice(oi2 + 1, ci2);
    const emNode = { t: tag, c: between, parent };
    for (const ch of between) ch.parent = emNode;
    const replacement = [];
    if (opener.node.s.length > 0) replacement.push(opener.node);
    replacement.push(emNode);
    if (closer.node.s.length > 0) {
      // Closer remainder goes INSIDE the em/strong iff a live same-char
      // delimiter sits between opener and closer in the delimiter list.
      // "Live" means still active with count left: a delimiter consumed
      // by an inner pair (count 0, inactive) must not count, or the
      // leftover of a trailing run lands inside the outer em instead of
      // after it (*a *b*c** -> <em>a <em>b</em>c</em>*).
      // (A wasStrong variant was tried and reverted: it fixed the
      // synthetic *a**b**c** battery cases but lost 3 docs.)
      let closerInside = false;
      for (let j = oi + 1; j < ci; j++) {
        const d = delims[j];
        if (d.ch === closer.ch && d.active && d.count > 0 && (d.canOpen || d.canClose) && !isMasked(d, src)) { closerInside = true; break; }
      }
      // Exception (doc-30/doc-11, STRONG only): a CONSUMED inner
      // delimiter that is a "both" run (canOpen && canClose — its
      // closer sits adjacent to the text running into this closer,
      // e.g. *tool*one***) also pulls the remainder inside: marked's
      // forward scan skips it via the rule of 3 (f), so the closer's
      // raw span swallows the extra delimiter as content. A consumed
      // close-only delimiter (followed by a space, e.g. *b* c***) does
      // not. For an EM pairing (use 1) the remainder stays outside
      // (*changes *else*returns** -> <em>...</em>*, doc-04/20).
      if (!closerInside && use === 2) {
        for (let j = oi + 1; j < ci; j++) {
          const d = delims[j];
          if (d.ch === closer.ch && !d.active && d.canOpen && d.canClose && !isMasked(d, src)) { closerInside = true; break; }
        }
      }
      if (closerInside) { emNode.c.push(closer.node); closer.node.parent = emNode; }
      else replacement.push(closer.node);
    }
    parent.c.splice(oi2, ci2 - oi2 + 1, ...replacement);
    if (opener.count === 0) opener.active = false;
    if (closer.count === 0) { closer.active = false; ci++; }
  }
}

// ---- Rendering -----------------------------------------------------------
// Block tree -> HTML. Inline content is parsed (from b.lines / b.text /
// table cells) in a post-pass, then rendered here.

/** Strip HTML tags from a plain-text string (for image alt text). */
function stripTags(s) {
  return s.replace(/<!--[\s\S]*?-->/g, '').replace(/<\/?[A-Za-z][^>]*>/g, '');
}

function renderInlineNodes(nodes, out) {
  for (const nd of nodes) {
    switch (nd.t) {
      case 'text': out.push(nd.escAll ? escAll(nd.s) : esc(nd.s)); break;
      case 'atext': out.push(escAll(nd.s)); break;
      case 'code': out.push('<code>' + escAll(nd.s) + '</code>'); break;
      case 'html': out.push(nd.s); break;
      case 'br': out.push('<br>'); break;
      case 'em': out.push('<em>'); renderInlineNodes(nd.c, out); out.push('</em>'); break;
      case 'strong': out.push('<strong>'); renderInlineNodes(nd.c, out); out.push('</strong>'); break;
      case 'del': out.push('<del>'); renderInlineNodes(nd.c, out); out.push('</del>'); break;
      case 'link': {
        out.push('<a href="' + nd.href + '"');
        if (nd.title !== null && nd.title !== undefined) out.push(' title="' + esc(nd.title) + '"');
        out.push('>');
        renderInlineNodes(nd.c, out);
        out.push('</a>');
        break;
      }
      case 'img': {
        const alt = esc(stripTags(plainText(nd.c || [])));
        out.push('<img src="' + nd.src + '" alt="' + alt + '"');
        if (nd.title !== null && nd.title !== undefined) out.push(' title="' + esc(nd.title) + '"');
        out.push('>');
        break;
      }
    }
  }
}

/**
 * Render one block. `inTightItem` is true only for the direct children of
 * a tight list item, where paragraphs render as bare inline content.
 */
function renderBlock(b, out, inTightItem) {
  switch (b.t) {
    case T_DOC:
      for (const ch of b.c) renderBlock(ch, out, false);
      break;
    case T_QUOTE:
      out.push('<blockquote>\n');
      for (const ch of b.c) renderBlock(ch, out, false);
      out.push('</blockquote>\n');
      break;
    case T_LIST: {
      const tag = b.kind === 'ol' ? 'ol' : 'ul';
      out.push('<' + tag);
      if (b.kind === 'ol' && b.start !== 1) out.push(' start="' + b.start + '"');
      out.push('>\n');
      for (const ch of b.c) renderBlock(ch, out, !b.loose);
      out.push('</' + tag + '>\n');
      break;
    }
    case T_ITEM: {
      out.push('<li>');
      for (const ch of b.c) renderBlock(ch, out, inTightItem);
      out.push('</li>\n');
      break;
    }
    case T_PARA: {
      // a task item's checkbox renders at the start of its first
      // paragraph (inside the <p> when loose), followed by one space
      // (gfm-279/280: "<input ...> foo", exactly one space).
      let taskInput = '';
      const par = b.parent;
      if (par && par.t === T_ITEM && par.task && par.c[0] === b) {
        taskInput = par.task === 1
          ? '<input disabled="" type="checkbox"> '
          : '<input checked="" disabled="" type="checkbox"> ';
      }
      if (inTightItem) {
        if (taskInput) out.push(taskInput);
        renderInlineNodes(b.inline, out);
      } else {
        out.push('<p>');
        if (taskInput) out.push(taskInput);
        renderInlineNodes(b.inline, out);
        out.push('</p>\n');
      }
      break;
    }
    case T_HEAD:
      out.push('<h' + b.level + '>');
      renderInlineNodes(b.inline, out);
      out.push('</h' + b.level + '>\n');
      break;
    case T_HR:
      out.push('<hr>\n');
      break;
    case T_FENCE: {
      out.push('<pre><code');
      if (b.info) {
        let e = b.info.length;
        const sp = b.info.indexOf(' ');
        const tb = b.info.indexOf('\t');
        if (sp !== -1) e = Math.min(e, sp);
        if (tb !== -1) e = Math.min(e, tb);
        // the info word's backslash escapes are resolved (\+ -> +)
        let word = b.info.slice(0, e);
        if (word.indexOf('\\') !== -1) {
          let w = '';
          for (let k = 0; k < word.length; k++) {
            if (word.charCodeAt(k) === 92 && k + 1 < word.length && isPunct(word.charCodeAt(k + 1))) {
              w += word[k + 1];
              k++;
            } else {
              w += word[k];
            }
          }
          word = w;
        }
        out.push(' class="language-' + esc(word) + '"');
      }
      out.push('>');
      if (b.lines.length > 0) out.push(escAll(b.lines.join('\n') + '\n'));
      out.push('</code></pre>\n');
      break;
    }
    case T_CODE: {
      out.push('<pre><code>');
      if (b.lines.length > 0) out.push(escAll(b.lines.join('\n') + '\n'));
      out.push('</code></pre>\n');
      break;
    }
    case T_HTML:
      out.push(b.text);
      break;
    case T_TABLE: {
      out.push('<table>\n<thead>\n<tr>\n');
      for (let k = 0; k < b.head.length; k++) {
        out.push('<th');
        const a = b.align[k];
        if (a) out.push(' align="' + a + '"');
        out.push('>');
        renderInlineNodes(b.headInline[k], out);
        out.push('</th>\n');
      }
      out.push('</tr>\n</thead>\n');
      if (b.rows.length > 0) {
        out.push('<tbody>');
        for (const row of b.rows) {
          out.push('<tr>\n');
          for (let k = 0; k < b.head.length; k++) {
            out.push('<td');
            const a = b.align[k];
            if (a) out.push(' align="' + a + '"');
            out.push('>');
            const cell = row[k];
            if (cell !== undefined) renderInlineNodes(cell, out);
            out.push('</td>\n');
          }
          out.push('</tr>\n');
        }
        out.push('</tbody></table>\n');
      } else {
        out.push('</table>\n');
      }
      break;
    }
  }
}

/** Walk the block tree and parse inline content for paragraphs, headings and table cells. */
function parseInlineInBlocks(blocks, refs) {
  for (const b of blocks) {
    if (b.t === T_PARA) {
      b.inline = parseInline(b.lines.join('\n'), refs).c;
    } else if (b.t === T_HEAD) {
      b.inline = parseInline(b.text, refs).c;
    } else if (b.t === T_TABLE) {
      b.headInline = b.head.map((cell) => parseInline(cell, refs).c);
      b.rowsInline = b.rows.map((row) => row.map((cell) => parseInline(cell, refs).c));
      // the renderer indexes rows by head count; pad rows to head length
      for (let r = 0; r < b.rowsInline.length; r++) {
        while (b.rowsInline[r].length < b.head.length) b.rowsInline[r].push([]);
        b.rowsInline[r].length = b.head.length;
      }
      b.rows = b.rowsInline;
    } else if (b.c) {
      parseInlineInBlocks(b.c, refs);
    }
  }
}

/**
 * The entry point. Normalizes line endings, splits into lines (dropping
 * the final empty element when the input ends with a newline), builds the
 * block tree, parses inline content, and renders to HTML.
 */
export function parse(markdown) {
  inLinkDoc = false;
  const normalized = markdown.replace(/\r\n?/g, '\n');
  const endsWithNl = normalized.endsWith('\n');
  let lines = normalized.split('\n');
  if (endsWithNl) lines.pop();
  const { doc, refs } = parseBlocks(lines, endsWithNl);
  parseInlineInBlocks(doc.c, refs);
  const out = [];
  renderBlock(doc, out, false);
  return out.join('');
}
