import { decodeHtml, hash, normalizeWord, sanitizeDefinition, stripTags } from './text.mjs';

const WORD_CLASSES = new Set(['n', 'v', 'a', 'adv', 'num', 'p', 'pron']);

export function extractElementInnerById(html, id) {
  const startPattern = new RegExp(`<([a-z][\\w:-]*)\\b[^>]*\\bid=["']${id}["'][^>]*>`, 'i');
  const start = startPattern.exec(html);
  if (!start) return '';
  const tagName = start[1];
  const contentStart = start.index + start[0].length;
  const tokens = new RegExp(`<\\/?${tagName}\\b[^>]*>`, 'gi');
  tokens.lastIndex = contentStart;
  let depth = 1;
  for (const token of html.matchAll(tokens)) {
    if (token.index < contentStart) continue;
    if (/^<\//.test(token[0])) depth -= 1;
    else if (!/\/>$/.test(token[0])) depth += 1;
    if (depth === 0) return html.slice(contentStart, token.index);
  }
  return '';
}

function firstTag(html, tag) {
  return new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\/${tag}>`, 'i').exec(html)?.[1] ?? '';
}

function extractClasses(html) {
  const classes = [...html.matchAll(/<em\b[^>]*>([\s\S]*?)<\/em>/gi)]
    .map((match) => stripTags(match[1]).trim().toLowerCase());
  return classes.find((item) => WORD_CLASSES.has(item)) ?? '';
}

function withoutEntryHeader(html) {
  return html
    .replace(/^\s*<b\b[^>]*>[\s\S]*?<\/b>/i, '')
    .replace(/^\s*<em\b[^>]*>[\s\S]*?<\/em>/i, '')
    .trim();
}

function extractSenses(definitionHtml) {
  const base = definitionHtml.split(/<br\s*\/?\s*>/i)[0] ?? '';
  const body = withoutEntryHeader(base)
    .replace(/<b\b[^>]*>\s*(\d+)\s*<\/b>/gi, '\n§$1§ ');
  const text = stripTags(body);
  const numbered = [...text.matchAll(/(?:^|\n)§(\d+)§\s*([\s\S]*?)(?=\n§\d+§|$)/g)]
    .map((match) => ({ number: Number(match[1]), text: match[2].trim() }))
    .filter((sense) => sense.text);
  if (numbered.length) return numbered;
  return text ? [{ number: 1, text }] : [];
}

function extractDerivatives(definitionHtml, baseWord) {
  const segments = definitionHtml.split(/<br\s*\/?\s*>/i).slice(1);
  const derivatives = [];
  for (const segment of segments) {
    const bold = /^\s*<b\b[^>]*>([\s\S]*?)<\/b>/i.exec(segment);
    if (!bold) continue;
    let label = stripTags(bold[1]).replace(/^--\s*/, `${baseWord} `).trim();
    label = normalizeWord(label);
    if (!label || /^\d+$/.test(label)) continue;
    const meaning = stripTags(segment.slice(bold.index + bold[0].length))
      .replace(/^\s*\d+\s*/, '')
      .trim();
    if (label.length <= 100 && meaning) derivatives.push({ word: label, meaning });
  }
  const seen = new Set();
  return derivatives.filter((item) => {
    const key = item.word.toLocaleLowerCase('id');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 160);
}

function extractRelations(definitionText) {
  const relations = [];
  const patterns = [
    { type: 'rujukan', re: /(?:→|\blihat\b)\s+([\p{L}][\p{L} -]{1,60})/giu },
    { type: 'sinonim', re: /\bsinonim(?:\s+dengan|\s+dari)?\s+([\p{L}][\p{L} -]{1,60})/giu },
    { type: 'antonim', re: /\bantonim(?:\s+dengan|\s+dari)?\s+([\p{L}][\p{L} -]{1,60})/giu }
  ];
  for (const { type, re } of patterns) {
    for (const match of definitionText.matchAll(re)) {
      const target = match[1].split(/[;,.(\n]/)[0].trim();
      if (target) relations.push({ type, target, source: 'kbbi-explicit', confidence: 1 });
    }
  }
  return relations;
}

export function parseEntryPage(html, { slug, sourceUrl }) {
  const rawDefinition = extractElementInnerById(html, 'd1');
  if (!rawDefinition) throw new Error('Elemen definisi #d1 tidak ditemukan');
  const definitionHtml = sanitizeDefinition(rawDefinition);
  const firstBold = firstTag(definitionHtml, 'b');
  if (!firstBold) throw new Error('Lema utama tidak ditemukan');

  const homonymText = firstTag(firstBold, 'sup');
  const headWithoutHomonym = firstBold.replace(/<sup\b[^>]*>[\s\S]*?<\/sup>/gi, '');
  const syllables = stripTags(headWithoutHomonym).trim();
  const word = normalizeWord(headWithoutHomonym);
  const displayWord = `${word}${homonymText ? ` ${stripTags(homonymText)}` : ''}`;
  const definitionText = stripTags(definitionHtml);
  const senses = extractSenses(definitionHtml);
  const derivatives = extractDerivatives(definitionHtml, word);

  return {
    slug,
    word,
    displayWord,
    syllables,
    homonym: Number.parseInt(stripTags(homonymText), 10) || null,
    wordClass: extractClasses(definitionHtml),
    definitionHtml,
    definitionText,
    senses,
    derivatives,
    relations: extractRelations(definitionText),
    sourceUrl,
    contentHash: hash(definitionHtml)
  };
}

export function parseSitemap(xml) {
  return [...String(xml).matchAll(/<loc>([\s\S]*?)<\/loc>/gi)]
    .map((match) => decodeHtml(match[1].trim()))
    .filter((url) => /^https:\/\/kbbi\.web\.id\//i.test(url));
}
