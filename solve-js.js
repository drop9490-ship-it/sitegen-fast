// sitegen-fast v1: a faster drop-in for makefun-site 1.0.0.
// Same answers, byte for byte. Strategy: fuse lex+render into one pass,
// bulk-escape plain runs (the reference escapes one character at a time),
// compile templates to JS functions with includes inlined at compile time,
// cache slugs, and avoid token/object allocations in the hot loops.
// No dependencies, no WASM, no native code, no network, no clock.

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_TEST = /[&<>"']/;
const ESC_RE = /[&<>"']/g;
function esc(text) {
  return ESC_TEST.test(text) ? text.replace(ESC_RE, (c) => ESCAPES[c]) : text;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function longDate(date) {
  const y = date.slice(0, 4), m = Number(date.slice(5, 7)), d = Number(date.slice(8, 10));
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

const slugCache = new Map();
function slugify(text) {
  let c = slugCache.get(text);
  if (c !== undefined) return c;
  let plain = text;
  let ascii = true;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) > 127) { ascii = false; break; }
  if (!ascii) plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const ch = plain[i];
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) { gap = out.length > 0; continue; }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, 64).replace(/-+$/, '');
  const res = out === '' ? 'untitled' : out;
  if (slugCache.size > 20000) slugCache.clear();
  slugCache.set(text, res);
  return res;
}
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const RESERVED = ['posts', 'tags', 'page'];

// ---------------------------------------------------------------- front matter
const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const LINE_RE = /^([a-z_]+):(?: (.*))?$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME_RE = /^[a-z0-9-]+$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG_RE = /^[^"[\]]+$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) { // '"'
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n; i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' }; // '['
  return { value: raw };
}
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE_RE.exec(raw);
      const y = m ? Number(m[1]) : 0, mo = m ? Number(m[2]) : 0, d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !TAG_RE.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME_RE.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG_RE.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}
// Returns {data, bodyLines} or {error}. bodyLines is the split text's tail (no re-join).
function parseFrontMatter(text) {
  const lines = text.split('\n');
  if (lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) if (lines[i] === '---') { close = i; break; }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (/^[ \t]*$/.test(line) || line.charCodeAt(0) === 35) continue; // blank or '#'
    const m = LINE_RE.exec(line);
    if (!m) return { error: `line ${i + 1} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
    if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, bodyLines: lines.slice(close + 1) };
}

// ---------------------------------------------------------------- markdown
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

function isBlank(line) {
  for (let i = 0; i < line.length; i++) { const c = line.charCodeAt(i); if (c !== 32 && c !== 9) return false; }
  return true;
}
function trimLine(line) {
  let a = 0, b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return line.slice(a, b);
}
// fence open: returns lang string, or null. fence close: boolean.
function fenceOpen(line) {
  if (!line.startsWith('```')) return null;
  let i = 3;
  const start = i;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  const lang = line.slice(start, i);
  while (i < line.length) { const c = line.charCodeAt(i); if (c !== 32 && c !== 9) return null; i++; }
  return lang;
}
function fenceClose(line) {
  if (!line.startsWith('```')) return false;
  for (let i = 3; i < line.length; i++) { const c = line.charCodeAt(i); if (c !== 32 && c !== 9) return false; }
  return true;
}
function headingInfo(line) {
  let n = 0;
  while (n < line.length && line.charCodeAt(n) === 35) n++;
  if (n === 0 || n > 6) return null;
  if (n >= line.length) return null;
  const c = line.charCodeAt(n);
  if (c !== 32 && c !== 9) return null;
  let j = n;
  while (j < line.length && (line.charCodeAt(j) === 32 || line.charCodeAt(j) === 9)) j++;
  let b = line.length;
  while (b > j && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  if (b === j) return null;
  return { depth: n, text: line.slice(j, b) };
}
function isHR(line) {
  if (!line.startsWith('---') && !line.startsWith('***')) return false;
  for (let i = 3; i < line.length; i++) { const c = line.charCodeAt(i); if (c !== 32 && c !== 9) return false; }
  return true;
}
function endsParagraph(line) {
  return isBlank(line) || fenceOpen(line) !== null || headingInfo(line) !== null || isHR(line);
}
function bulletInfo(line) {
  const c0 = line.charCodeAt(0);
  if ((c0 === 45 || c0 === 42) && line.charCodeAt(1) === 32) return { ordered: false, text: line.slice(2) };
  return null;
}
function orderedInfo(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) >= 48 && line.charCodeAt(i) <= 57) i++;
  if (i === 0 || i > 9) return null;
  if (line.charCodeAt(i) !== 46 || line.charCodeAt(i + 1) !== 32) return null; // '. '
  return { ordered: true, num: Number(line.slice(0, i)), text: line.slice(i + 2) };
}
function isContinued(line) {
  if (line.length < 3) return false;
  if (line.charCodeAt(0) !== 32 || line.charCodeAt(1) !== 32) return false;
  const c = line.charCodeAt(2);
  return c !== 32 && c !== 9;
}

function findUnescaped(s, what, from) {
  if (s.indexOf('\\', from) === -1) return s.indexOf(what, from);
  for (let j = from; j <= s.length - what.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (c !== '*') continue;
    if (s[j + 1] === '*') { j++; continue; }
    return j;
  }
  return -1;
}

const INLINE_SPECIAL = /[\\`*\[]/;
function nextSpecial(s, from) {
  let j = s.length;
  for (const ch of ['\\', '`', '*', '[']) {
    const k = s.indexOf(ch, from);
    if (k !== -1 && k < j) j = k;
  }
  return j;
}
function inline(s, env) {
  if (!INLINE_SPECIAL.test(s)) return esc(s);
  const out = [];
  let i = 0;
  const n = s.length;
  let ps = 0;
  const flush = (end) => { if (end > ps) out.push(esc(s.slice(ps, end))); };
  while (i < n) {
    const j = nextSpecial(s, i);
    if (j >= n) break;
    const c = s[j];
    if (c === '\\') {
      if (j + 1 < n && ESCAPABLE.has(s[j + 1])) { flush(j); out.push(ESCAPES[s[j + 1]] ?? s[j + 1]); i = j + 2; ps = i; }
      else i = j + 1;
      continue;
    }
    if (c === '`') {
      const k = s.indexOf('`', j + 1);
      if (k > j + 1) { flush(j); out.push('<code>', esc(s.slice(j + 1, k)), '</code>'); i = k + 1; ps = i; }
      else i = j + 1;
      continue;
    }
    if (c === '*') {
      if (s[j + 1] === '*') {
        const k = findUnescaped(s, '**', j + 2);
        if (k > j + 2) { flush(j); out.push('<strong>', inline(s.slice(j + 2, k), env), '</strong>'); i = k + 2; ps = i; }
        else i = j + 2;
        continue;
      }
      const k = findSingleStar(s, j + 1);
      if (k > j + 1) { flush(j); out.push('<em>', inline(s.slice(j + 1, k), env), '</em>'); i = k + 1; ps = i; }
      else i = j + 1;
      continue;
    }
    // '['
    const k = findUnescaped(s, ']', j + 1);
    const m = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
    const target = m === -1 ? '' : s.slice(k + 2, m);
    if (target !== '' && !/\s/.test(target)) {
      flush(j);
      out.push('<a href="', esc(env.link(target)), '">', inline(s.slice(j + 1, k), env), '</a>');
      i = m + 1; ps = i;
      continue;
    }
    i = j + 1;
  }
  flush(n);
  return out.join('');
}

function renderMarkdown(lines, env) {
  const L = lines.length;
  // One classification pass per line (kind + aux), plus the body's word count.
  // Kinds: 0 blank, 1 fence, 2 heading, 3 hr, 4 quote, 5 bullet, 6 ordered, 7 other.
  const kinds = new Uint8Array(L);
  const aux = new Array(L);
  let words = 0;
  for (let i = 0; i < L; i++) {
    const line = lines[i];
    let inW = false;
    for (let j = 0; j < line.length; j++) {
      const c = line.charCodeAt(j);
      const ws = c <= 32 || c === 160 || (c >= 8192 && c <= 8202) || c === 8239 || c === 8287 || c === 12288 || c === 65279;
      if (ws) inW = false; else if (!inW) { inW = true; words++; }
    }
    const c0 = line.length === 0 ? 0 : line.charCodeAt(0);
    if (c0 === 32 || c0 === 9 || c0 === 0) { kinds[i] = isBlank(line) ? 0 : 7; continue; }
    if (c0 === 96) { // '`'
      const lang = fenceOpen(line);
      if (lang !== null) { kinds[i] = 1; aux[i] = lang; continue; }
      kinds[i] = 7; continue;
    }
    if (c0 === 35) { // '#'
      const hd = headingInfo(line);
      if (hd !== null) { kinds[i] = 2; aux[i] = hd; continue; }
      kinds[i] = 7; continue;
    }
    if (c0 === 45 || c0 === 42) { // '-' or '*'
      if (isHR(line)) { kinds[i] = 3; continue; }
      if (bulletInfo(line) !== null) { kinds[i] = 5; continue; }
      kinds[i] = 7; continue;
    }
    if (c0 === 62) { kinds[i] = 4; continue; } // '>'
    if (c0 >= 48 && c0 <= 57) {
      const o = orderedInfo(line);
      if (o !== null) { kinds[i] = 6; aux[i] = o.num; continue; }
    }
    kinds[i] = 7;
  }
  const blocks = [];
  const toc = [];
  const ids = new Set();
  let excerpt = null;
  let i = 0;
  while (i < L) {
    const kind = kinds[i];
    const line = lines[i];
    if (kind === 0) { i++; continue; }
    if (kind === 1) {
      const lang = aux[i];
      i++;
      let body = '';
      while (i < L && !fenceClose(lines[i])) { body += esc(lines[i]) + '\n'; i++; }
      i++;
      blocks.push(`<pre><code${lang === '' ? '' : ` class="language-${esc(lang)}"`}>${body}</code></pre>`);
      continue;
    }
    if (kind === 2) {
      const hd = aux[i];
      const id = uniqueSlug(slugify(hd.text), ids);
      const html = inline(hd.text, env);
      blocks.push(`<h${hd.depth} id="${id}">${html}</h${hd.depth}>`);
      if (hd.depth === 2 || hd.depth === 3) toc.push({ level: hd.depth, id, html });
      i++;
      continue;
    }
    if (kind === 3) { blocks.push('<hr>'); i++; continue; }
    if (kind === 4) {
      const parts = [];
      while (i < L && kinds[i] === 4) {
        let l = lines[i];
        l = l.startsWith('> ') ? l.slice(2) : l.slice(1);
        parts.push(trimLine(l));
        i++;
      }
      const kept = parts.filter((l) => l !== '');
      blocks.push(kept.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inline(kept.join('\n'), env)}</p>\n</blockquote>`);
      continue;
    }
    if (kind === 5 || kind === 6) {
      const isOrdered = kind === 6;
      const start = isOrdered ? aux[i] : 1;
      const items = [];
      while (i < L) {
        const cur = lines[i];
        if (!isOrdered && kinds[i] === 5) { items.push([trimLine(bulletInfo(cur).text)]); i++; }
        else if (isOrdered && kinds[i] === 6) { items.push([trimLine(orderedInfo(cur).text)]); i++; }
        else if (isContinued(cur)) { items[items.length - 1].push(trimLine(cur)); i++; }
        else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`;
      let str = `${open}\n`;
      for (const parts of items) str += `<li>${inline(parts.join('\n'), env)}</li>\n`;
      str += `</${tag}>`;
      blocks.push(str);
      continue;
    }
    // paragraph: kinds 4,5,6,7 are all plain text lines here
    const body = [trimLine(line)];
    i++;
    while (i < L && kinds[i] >= 4) body.push(trimLine(lines[i++]));
    const html = inline(body.join('\n'), env);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  let html = '';
  for (const b of blocks) html += b + '\n';
  return { html, toc, excerpt: excerpt ?? '', words };
}

// ---------------------------------------------------------------- templates
class TemplateError extends Error {}
const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) { text += src.slice(i); break; }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') { text += src.slice(i, open + 1); i = open + 1; continue; }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node); stack.push(node); body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node); stack.push(node); body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = []; body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

// --- template value helpers (same semantics as the reference) ---
function own(v, k) {
  return v !== null && (typeof v === 'object' || typeof v === 'function') && Object.prototype.hasOwnProperty.call(v, k) ? v[k] : undefined;
}
function txt(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let s = '';
    for (let i = 0; i < v.length; i++) { if (i > 0) s += ', '; s += txt(v[i]); }
    return s;
  }
  return '';
}
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

// Root names a template (transitively, through includes, in its loop scopes)
// reads: anything outside {site,tags,recent} makes it page-dependent.
function rootDeps(nodes, templates) {
  const deps = new Set();
  function walk(ns, depth, scopes) {
    for (const n of ns) {
      if (n.kind === 'var' || n.kind === 'raw' || n.kind === 'if' || n.kind === 'for') {
        const first = n.path[0];
        if (!scopes.some((sc) => sc.has(first))) deps.add(first);
      }
      if (n.kind === 'for') walk(n.body, depth, [...scopes, new Set([n.name, 'loop'])]);
      else if (n.kind === 'if') { walk(n.then, depth, scopes); if (n.else !== null) walk(n.else, depth, scopes); }
      else if (n.kind === 'include' && depth < 8) {
        const t = templates.get(n.name);
        if (t !== undefined) walk(t, depth + 1, scopes);
      }
    }
  }
  walk(nodes, 0, []);
  return deps;
}

// --- compile a parsed template to a JS function; includes inlined, depth<=8 ---
// Includes of constant templates (only site/tags/recent) become C(name,R) calls:
// C memoises them per case, so header/nav/footer render once, not per page.
function compileTemplate(nodes, templates, constantSet) {
  let uid = 0;
  const parts = [];
  function pathExpr(path, scopes) {
    const first = path[0];
    let base;
    let k = 1;
    for (let s = scopes.length - 1; s >= 0; s--) {
      const hit = scopes[s].get(first);
      if (hit !== undefined) { base = hit; break; }
    }
    if (base === undefined) base = `own(R,${JSON.stringify(first)})`;
    for (; k < path.length; k++) base = `own(${base},${JSON.stringify(path[k])})`;
    return base;
  }
  function emit(nodes, depth, scopes) {
    for (const n of nodes) {
      if (n.kind === 'text') parts.push(`o+=${JSON.stringify(n.text)};`);
      else if (n.kind === 'var') parts.push(`o+=esc(txt(${pathExpr(n.path, scopes)}));`);
      else if (n.kind === 'raw') parts.push(`o+=txt(${pathExpr(n.path, scopes)});`);
      else if (n.kind === 'if') {
        parts.push(`if(${n.not ? '!' : ''}truthy(${pathExpr(n.path, scopes)})){`);
        emit(n.then, depth, scopes);
        if (n.else !== null) { parts.push('}else{'); emit(n.else, depth, scopes); }
        parts.push('}');
      } else if (n.kind === 'for') {
        const u = uid++;
        const a = `_a${u}`, v = `_v${u}`, l = `_l${u}`, ix = `_i${u}`;
        parts.push(`{const ${a}=${pathExpr(n.path, scopes)};if(Array.isArray(${a})){const ${l}={index:0,first:false,last:false,length:${a}.length};for(let ${ix}=0;${ix}<${a}.length;${ix}++){const ${v}=${a}[${ix}];${l}.index=${ix}+1;${l}.first=${ix}===0;${l}.last=${ix}===${a}.length-1;`);
        const scope = new Map([[n.name, v], ['loop', l]]);
        scopes.push(scope);
        emit(n.body, depth, scopes);
        scopes.pop();
        parts.push('}}}');
      } else if (n.kind === 'include') {
        if (constantSet.has(n.name) && depth < 8 && templates.has(n.name)) {
          parts.push(`o+=C(${JSON.stringify(n.name)},R);`);
        } else if (depth < 8) {
          const t = templates.get(n.name);
          if (t !== undefined) emit(t, depth + 1, scopes);
        }
      }
    }
  }
  emit(nodes, 0, []);
  const src = `"use strict";let o="";${parts.join('')}return o;`;
  return new Function('R', 'own', 'txt', 'esc', 'truthy', 'C', src);
}

// Interpreter fallback (only if `new Function` is unavailable/blocked).
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}
function renderNodesSlow(nodes, scope, templates, depth) {
  let out = '';
  for (const n of nodes) {
    if (n.kind === 'text') out += n.text;
    else if (n.kind === 'var') out += esc(txt(lookup(scope, n.path)));
    else if (n.kind === 'raw') out += txt(lookup(scope, n.path));
    else if (n.kind === 'if') {
      const v = truthy(lookup(scope, n.path));
      const branch = v !== n.not ? n.then : n.else;
      if (branch !== null) out += renderNodesSlow(branch, scope, templates, depth);
    } else if (n.kind === 'for') {
      const xs = lookup(scope, n.path);
      if (!Array.isArray(xs)) continue;
      for (let k = 0; k < xs.length; k++) {
        const vars = { [n.name]: xs[k], loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length } };
        out += renderNodesSlow(n.body, { vars, parent: scope }, templates, depth);
      }
    } else if (n.kind === 'include') {
      const t = templates.get(n.name);
      if (t !== undefined && depth < 8) out += renderNodesSlow(t, scope, templates, depth + 1);
    }
  }
  return out;
}

// ---------------------------------------------------------------- build
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (parts.length === 0) return null; parts.pop(); }
    else parts.push(seg);
  }
  return parts.join('/');
}
const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

export function run(input) {
  const report = [];
  const templates = new Map(); // name -> parsed nodes
  const compiled = new Map(); // name -> fn(R) or null (use slow path)
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      const nodes = parseTemplate(name, input.templates[name]);
      templates.set(name, nodes);
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const constantSet = new Set();
  for (const [name, nodes] of templates) {
    const deps = rootDeps(nodes, templates);
    let ok = true;
    for (const d of deps) if (d !== 'site' && d !== 'tags' && d !== 'recent') { ok = false; break; }
    if (ok) constantSet.add(name);
  }
  for (const [name, nodes] of templates) {
    try { compiled.set(name, compileTemplate(nodes, templates, constantSet)); }
    catch { compiled.set(name, null); }
  }
  const memo = new Map();
  const constRenderer = (name, R) => {
    let v = memo.get(name);
    if (v !== undefined) return v;
    const fn = compiled.get(name);
    v = fn !== null ? fn(R, own, txt, esc, truthy, constRenderer)
      : renderNodesSlow(templates.get(name), { vars: R, parent: null }, templates, 0);
    memo.set(name, v);
    return v;
  };
  const render = (name, rootVars) => {
    const fn = compiled.get(name);
    if (fn === undefined) return null;
    if (constantSet.has(name)) return constRenderer(name, rootVars);
    if (fn !== null) return fn(rootVars, own, txt, esc, truthy, constRenderer);
    return renderNodesSlow(templates.get(name), { vars: rootVars, parent: null }, templates, 0);
  };

  const base = input.site.base_url.replace(/\/+$/, '');
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    else statics.push(f);
  }

  // front matter
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) { report.push(`refused ${s.path}: ${fm.error}`); continue; }
    s.data = fm.data;
    s.bodyLines = fm.bodyLines;
    s.post = s.path.startsWith('posts/');
    const ownDir = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : undefined;
    if (ownDir !== undefined) { report.push(`refused ${s.path}: ${ownDir}/ is the generator's own`); continue; }
    if (s.post && !Object.hasOwn(s.data, 'date')) { report.push(`refused ${s.path}: a post needs a date`); continue; }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) { report.push(`refused ${s.path}: layout "${layout}" is no template that parses`); continue; }
    s.layout = layout;
    if (s.data.draft === true) { report.push(`draft ${s.path}`); continue; }
    kept.push(s);
  }

  // permalinks
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) { set = new Set(dir === '' ? RESERVED : []); taken.set(dir, set); }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // markdown
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.bodyLines, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.readingMinutes = Math.max(1, Math.ceil(md.words / 200));
  }

  // collections
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // tags
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of (s.data.tags ?? [])) {
      const sl = slugify(name);
      if (!seen.has(sl)) { seen.add(sl); out.push(name); }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) { tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] }; bySlug.set(slug, tag); }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => {
      const slug = slugify(name);
      return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
    });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // cards / pages
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
  const cards = new Map();
  for (const p of posts) {
    cards.set(p, {
      title: p.data.title, url: p.url, date: p.data.date ?? '',
      date_long: p.data.date === undefined ? '' : longDate(p.data.date),
      summary: p.data.summary ?? '', excerpt: p.excerpt, reading_minutes: p.readingMinutes,
      tags: p.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
    });
  }
  const pageOf = (s) => {
    const c = {
      title: s.data.title, url: s.url, date: s.data.date ?? '',
      date_long: s.data.date === undefined ? '' : longDate(s.data.date),
      summary: s.data.summary ?? '', excerpt: s.excerpt, reading_minutes: s.readingMinutes,
      tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
    };
    c.slug = s.slug;
    c.content = s.html;
    c.toc = s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html }));
    c.newer = linkOf(s.newer ?? null);
    c.older = linkOf(s.older ?? null);
    c.is_post = s.post;
    return c;
  };

  // layouts
  const output = {};
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { site, tags: allTags, recent, page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      site, tags: allTags, recent,
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { site, tags: allTags, recent, tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', { site, tags: allTags, recent });
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // report
  const lines = [...report, ...broken].sort(byCodeUnits);
  const npages = kept.filter((s) => !s.post).length;
  lines.push(`built ${npages} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
