import { isKnownToken, labelInfo, WORD_CLASSES } from './labels.mjs';
import { decodeHtml, hash, normalizeWord, sanitizeDefinition, stripTags } from './text.mjs';

const MAX_LABEL_TOKENS = 5;

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
  return new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(html)?.[1] ?? '';
}

// Deret pembuka "Ar n", "n kim", atau "bentuk terikat" selalu tersusun dari
// singkatan yang dikenal. Pembacaan berhenti pada kata pertama yang tidak
// dikenal supaya kalimat contoh bercetak miring tidak terbaca sebagai label.
function readMarkers(fragment) {
  const text = stripTags(fragment)
    .replace(/\bbentuk\s+terikat\b/gi, 'bentukterikat')
    .replace(/\n/g, ' ')
    .trim();
  const parts = text.split(/\s+/)
    .map((raw) => raw.toLocaleLowerCase('id').replace(/^[([]+/, '').replace(/[).,;:\]]+$/, ''));
  const markers = [];
  let consumed = 0;
  for (let index = 0; index < parts.length && markers.length < MAX_LABEL_TOKENS; index += 1) {
    let token = parts[index];
    if (!token) break;
    let width = 1;
    // Sebagian halaman sumber memisah singkatan dua huruf, misalnya "k l n".
    if (!isKnownToken(token) && token.length === 1 && parts[index + 1]?.length === 1 && isKnownToken(token + parts[index + 1])) {
      token += parts[index + 1];
      index += 1;
      width = 2;
    }
    if (!isKnownToken(token)) break;
    markers.push(token);
    consumed += width;
  }
  return { markers, consumed };
}

function leadingMarkers(fragment) {
  return readMarkers(fragment).markers;
}

function splitMarkers(markers) {
  const wordClass = markers.find((token) => WORD_CLASSES.has(token)) ?? '';
  const seen = new Set();
  const labels = [];
  for (const token of markers) {
    if (WORD_CLASSES.has(token) || seen.has(token)) continue;
    seen.add(token);
    labels.push(labelInfo(token));
  }
  return { wordClass, labels };
}

function stripLeadingMarkers(text) {
  const { consumed } = readMarkers(text);
  let rest = String(text).trim();
  for (let index = 0; index < consumed; index += 1) rest = rest.replace(/^\S+\s*/, '');
  return rest.trim();
}

// Naskah makna kerap masih diawali sisa kepala lema: lafal dalam garis miring,
// bentuk berimbuhan serangkai yang bertanda pemenggalan suku kata, lalu label.
// Ketiganya dikupas berulang karena urutannya tidak selalu sama.
export function stripSenseHead(text) {
  let rest = String(text).trim();
  for (let guard = 0; guard < 6; guard += 1) {
    const before = rest;
    rest = rest.replace(/^[\s,;:.]+/, '')
      .replace(/^\/[^/]{2,60}\/\s*/, '')
      .replace(/^[\p{L}-]*·[\p{L}·-]*\s*/u, '');
    rest = stripLeadingMarkers(rest);
    if (rest === before) break;
  }
  return rest.trim();
}

// Naskah kepala lema: bagian sesudah lema tebal dan sebelum nomor makna pertama.
function headRegion(definitionHtml) {
  const base = definitionHtml.split(/<br\s*\/?\s*>/i)[0] ?? '';
  const afterHead = base.replace(/^\s*<b\b[^>]*>[\s\S]*?<\/b>/i, '');
  return { base, head: afterHead.split(/<b\b[^>]*>/i)[0] ?? afterHead };
}

export function extractMarkers(definitionHtml) {
  const { base, head } = headRegion(definitionHtml);
  const pronunciation = /\/\s*([^/<>]{2,60}?)\s*\//.exec(stripTags(head))?.[1] ?? '';
  const cleanHead = head.replace(/\/[^/<>]{2,60}\//, ' ');
  let markers = leadingMarkers(cleanHead);
  // Dua pola KBBI menaruh kelas kata di luar kepala lema: sesudah nomor makna
  // ("bahagia 1 n keadaan…") dan pada bentuk berimbuhan serangkai ("acau,
  // mengacau v berkata tidak keruan"). Penelusuran dibatasi pada segmen pertama
  // supaya kelas kata bentuk turunan sesudah <br> tidak ikut terbaca.
  if (!markers.some((token) => WORD_CLASSES.has(token))) {
    for (const match of base.matchAll(/<em\b[^>]*>([\s\S]*?)<\/em>/gi)) {
      const fallback = leadingMarkers(match[1]);
      if (fallback.some((token) => WORD_CLASSES.has(token))) {
        markers = [...markers, ...fallback];
        break;
      }
    }
  }
  return { ...splitMarkers(markers), pronunciation };
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
    .map((match) => ({ number: Number(match[1]), text: stripSenseHead(match[2]) }))
    .filter((sense) => sense.text);
  if (numbered.length) return numbered;
  const single = stripSenseHead(text);
  return single ? [{ number: 1, text: single }] : [];
}

function extractDerivatives(definitionHtml, baseWord) {
  const segments = definitionHtml.split(/<br\s*\/?\s*>/i).slice(1);
  const derivatives = [];
  for (const segment of segments) {
    const bold = /^\s*<b\b[^>]*>([\s\S]*?)<\/b>/i.exec(segment);
    if (!bold) continue;
    // Tanda "--" pada naskah sumber mewakili lema induk, di posisi mana pun.
    let label = normalizeWord(stripTags(bold[1]).replace(/--/g, baseWord));
    if (!label || /^\d+$/.test(label) || !/^[\p{L}\p{N}(-]/u.test(label)) continue;
    const rest = stripTags(segment.slice(bold.index + bold[0].length)).replace(/^\s*\d+\s*/, '');
    const meaning = stripSenseHead(rest);
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

// Dipakai bersama oleh scraper dan skrip pemugaran: keduanya bekerja dari
// naskah definisi yang sudah disanitasi, bukan dari halaman mentah.
// Sebagian halaman hanya berisi pengalihan ejaan, misalnya "ak·te ? akta".
// Panah aslinya sudah hilang menjadi tanda tanya pada naskah sumber. Tanpa
// penanganan khusus, seluruh baris tersimpan sebagai nama kata sehingga "akte"
// tidak dapat ditemukan sama sekali.
const REDIRECT_HEAD = /^([\p{L}\p{M}·'\- ]{2,60}?)\s*[?→]\s*([\p{L}\p{M}\d·'\- ]{2,60})$/u;

export function parseRedirectHead(headText) {
  const match = REDIRECT_HEAD.exec(String(headText).trim());
  if (!match) return null;
  return { head: match[1].trim(), target: normalizeWord(match[2]) };
}

// Nomor homonim biasanya ditulis <sup>1</sup>, tetapi beberapa halaman
// menuliskannya sebagai teks biasa di dalam lema tebal: "<b>aib 1 </b>".
function splitPlainHomonym(headText) {
  const match = /^(.{2,}?)\s+(\d)$/.exec(headText);
  return match ? { head: match[1].trim(), homonym: Number(match[2]) } : null;
}

export function parseDefinition(definitionHtml, { slug, sourceUrl }) {
  const firstBold = firstTag(definitionHtml, 'b');
  if (!firstBold) throw new Error('Lema utama tidak ditemukan');
  const supText = firstTag(firstBold, 'sup');
  const headWithoutHomonym = firstBold.replace(/<sup\b[^>]*>[\s\S]*?<\/sup>/gi, '');
  let headText = stripTags(headWithoutHomonym).trim();
  let homonym = Number.parseInt(stripTags(supText), 10) || null;
  const extraRelations = [];

  const redirect = parseRedirectHead(headText);
  if (redirect) {
    headText = redirect.head;
    if (redirect.target) extraRelations.push({ type: 'rujukan', target: redirect.target, source: 'kbbi-explicit', confidence: 1 });
  }
  if (!supText) {
    const plain = splitPlainHomonym(headText);
    if (plain) { headText = plain.head; homonym = plain.homonym; }
  }

  const syllables = headText;
  const word = normalizeWord(headText);
  const displayWord = `${word}${supText ? ` ${stripTags(supText)}` : ''}`;
  const definitionText = stripTags(definitionHtml);
  const { wordClass, labels, pronunciation } = extractMarkers(definitionHtml);
  const senses = redirect
    ? [{ number: 1, text: `Lihat “${redirect.target}”.` }]
    : extractSenses(definitionHtml);

  return {
    slug,
    word,
    displayWord,
    syllables,
    pronunciation,
    homonym,
    wordClass,
    labels,
    definitionHtml,
    definitionText,
    senses,
    derivatives: redirect ? [] : extractDerivatives(definitionHtml, word),
    relations: [...extraRelations, ...extractRelations(definitionText)],
    sourceUrl,
    contentHash: hash(definitionHtml)
  };
}

export function parseEntryPage(html, { slug, sourceUrl }) {
  const rawDefinition = extractElementInnerById(html, 'd1');
  if (!rawDefinition) throw new Error('Elemen definisi #d1 tidak ditemukan');
  return parseDefinition(sanitizeDefinition(rawDefinition), { slug, sourceUrl });
}

export function parseSitemap(xml) {
  return [...String(xml).matchAll(/<loc>([\s\S]*?)<\/loc>/gi)]
    .map((match) => decodeHtml(match[1].trim()))
    .filter((url) => /^https:\/\/kbbi\.web\.id\//i.test(url));
}
