import crypto from 'node:crypto';

const ENTITIES = new Map([
  ['amp', '&'], ['lt', '<'], ['gt', '>'], ['quot', '"'], ['apos', "'"],
  ['nbsp', ' '], ['middot', '·'], ['rarr', '→'], ['ndash', '–'],
  ['mdash', '—'], ['hellip', '…']
]);

export function decodeHtml(value = '') {
  return String(value).replace(/&(#x?[\da-f]+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] === '#') {
      const hex = entity[1]?.toLowerCase() === 'x';
      const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return ENTITIES.get(entity.toLowerCase()) ?? match;
  });
}

export function stripTags(value = '') {
  return decodeHtml(String(value)
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/(?:div|p|li|section|h\d)>/gi, '\n')
    .replace(/<[^>]*>/g, ''))
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function sanitizeDefinition(value = '') {
  let html = String(value)
    .replace(/<(script|style|iframe|object|embed|svg|math)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<!--([\s\S]*?)-->/g, '');

  const allowed = new Set(['b', 'strong', 'em', 'i', 'sup', 'sub', 'br', 'span', 'div']);
  html = html.replace(/<\/?([a-z][\w:-]*)\b[^>]*>/gi, (tag, name) => {
    const clean = name.toLowerCase();
    if (!allowed.has(clean)) return '';
    if (tag.startsWith('</')) return `</${clean}>`;
    if (clean === 'br') return '<br>';
    return `<${clean}>`;
  });
  return html.trim();
}

export function hash(value = '') {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

export function normalizeWord(value = '') {
  return decodeHtml(stripTags(value))
    .replace(/[\u00b7‧]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function safeJson(value, fallback = []) {
  try { return JSON.parse(value); } catch { return fallback; }
}

export function slugFromUrl(url) {
  try {
    const parsed = new URL(url);
    return decodeURIComponent(parsed.pathname.replace(/^\/+|\/+$/g, '') || 'beranda');
  } catch {
    return String(url).replace(/^.*\//, '');
  }
}
