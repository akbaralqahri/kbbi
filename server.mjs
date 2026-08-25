import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, getMeta, hydrateEntry } from './lib/db.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || '127.0.0.1';
const CLASS_LABELS = {
  n: 'Nomina', v: 'Verba', a: 'Adjektiva', adv: 'Adverbia', num: 'Numeralia',
  p: 'Partikel', pron: 'Pronomina', '': 'Tidak ditandai'
};
const REVERSE_RELATION = {
  sinonim: 'sinonim', antonim: 'antonim', rujukan: 'dirujuk oleh',
  hipernim: 'hiponim', hiponim: 'hipernim', meronim: 'holonim', holonim: 'meronim'
};

function json(response, data, status = 200) {
  const body = JSON.stringify(data);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store'
  });
  response.end(body);
}

function getStats() {
  const entryCount = db.prepare('SELECT COUNT(*) AS count FROM entries').get().count;
  const lexemeCount = db.prepare('SELECT COUNT(*) AS count FROM lexemes').get().count;
  const queueRows = db.prepare('SELECT state, COUNT(*) AS count FROM crawl_queue GROUP BY state').all();
  const queue = Object.fromEntries(queueRows.map((row) => [row.state, row.count]));
  const totalQueue = Object.values(queue).reduce((sum, count) => sum + count, 0);
  const relationRows = db.prepare('SELECT type, COUNT(*) AS count FROM relations GROUP BY type ORDER BY count DESC').all();
  const byClass = db.prepare(`
    SELECT COALESCE(NULLIF(e.word_class, ''), '') AS code, COUNT(*) AS count
    FROM lexemes l JOIN entries e ON e.slug=l.entry_slug GROUP BY code ORDER BY count DESC
  `).all().map((row) => ({ ...row, label: CLASS_LABELS[row.code] ?? row.code }));
  const byLetter = db.prepare(`
    SELECT UPPER(SUBSTR(word, 1, 1)) AS letter, COUNT(*) AS count
    FROM lexemes WHERE word <> '' GROUP BY letter ORDER BY letter
  `).all().filter((row) => /^[A-Z]$/i.test(row.letter));
  return {
    entries: entryCount,
    lexemes: lexemeCount,
    queue: { ...queue, total: totalQueue },
    coverage: totalQueue ? ((queue.done || 0) + (queue.skipped || 0)) / totalQueue : 0,
    relations: Object.fromEntries(relationRows.map((row) => [row.type, row.count])),
    relationTotal: relationRows.reduce((sum, row) => sum + row.count, 0),
    byClass,
    byLetter,
    crawl: {
      state: getMeta('crawl_state', 'idle'),
      sitemapFetchedAt: getMeta('sitemap_fetched_at'),
      lastActivityAt: getMeta('crawl_last_activity_at'),
      wordnetImportedAt: getMeta('wordnet_imported_at')
    },
    edition: 'KBBI Daring Edisi III (arsip)'
  };
}

function listWords(url) {
  const q = (url.searchParams.get('q') || '').trim().slice(0, 100);
  const letter = (url.searchParams.get('letter') || '').trim().slice(0, 1);
  const wordClass = (url.searchParams.get('class') || '').trim().slice(0, 12);
  const limit = Math.min(60, Math.max(1, Number(url.searchParams.get('limit')) || 24));
  const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
  const where = [];
  const params = [];
  if (q) {
    where.push('(l.word LIKE ? COLLATE NOCASE OR l.meaning LIKE ? COLLATE NOCASE OR e.definition_text LIKE ? COLLATE NOCASE)');
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  if (letter) { where.push('l.word LIKE ? COLLATE NOCASE'); params.push(`${letter}%`); }
  if (wordClass) { where.push('e.word_class = ?'); params.push(wordClass); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db.prepare(`
    SELECT e.slug, l.word, e.display_word, e.syllables, e.word_class, e.definition_text,
      e.scraped_at, l.kind, l.meaning
    FROM lexemes l JOIN entries e ON e.slug = l.entry_slug ${whereSql}
    ORDER BY ${q ? 'CASE WHEN LOWER(l.word)=LOWER(?) THEN 0 WHEN LOWER(l.word) LIKE LOWER(?) THEN 1 ELSE 2 END,' : ''}
      l.word COLLATE NOCASE, COALESCE(e.homonym, 0)
    LIMIT ? OFFSET ?
  `).all(...params, ...(q ? [q, `${q}%`] : []), limit, offset);
  const total = db.prepare(`SELECT COUNT(*) AS count FROM lexemes l JOIN entries e ON e.slug=l.entry_slug ${whereSql}`).get(...params).count;
  return {
    items: rows.map((row) => ({
      slug: row.slug, word: row.word, displayWord: row.kind === 'lema' ? row.display_word : row.word,
      syllables: row.kind === 'lema' ? row.syllables : '', kind: row.kind,
      wordClass: row.word_class, wordClassLabel: CLASS_LABELS[row.word_class] ?? row.word_class,
      summary: row.kind === 'turunan' ? row.meaning : cleanSummary(row.definition_text, row.word, row.word_class), scrapedAt: row.scraped_at
    })),
    total, limit, offset, hasMore: offset + rows.length < total
  };
}

function cleanSummary(text, word, wordClass) {
  let result = String(text || '').replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
  const head = `${word}${wordClass ? ` ${wordClass}` : ''}`.trim();
  if (result.toLocaleLowerCase('id').startsWith(head.toLocaleLowerCase('id'))) result = result.slice(head.length).trim();
  result = result.replace(/^\d+\s*/, '');
  return result.slice(0, 220);
}

function getRelations(word) {
  const direct = db.prepare(`
    SELECT word, type, source, confidence, synset_id FROM (
      SELECT target_word AS word, type, source, confidence, synset_id,
        ROW_NUMBER() OVER (PARTITION BY type ORDER BY confidence DESC, target_word) AS rank
      FROM relations WHERE source_word = ? COLLATE NOCASE
    ) WHERE rank <= 45
    ORDER BY CASE type WHEN 'sinonim' THEN 0 WHEN 'antonim' THEN 1 ELSE 2 END, confidence DESC, word
  `).all(word);
  const reverse = db.prepare(`
    SELECT word, type, source, confidence, synset_id FROM (
      SELECT source_word AS word, type, source, confidence, synset_id,
        ROW_NUMBER() OVER (PARTITION BY type ORDER BY confidence DESC, source_word) AS rank
      FROM relations WHERE target_word = ? COLLATE NOCASE
    ) WHERE rank <= 30 ORDER BY confidence DESC
  `).all(word).map((row) => ({ ...row, type: REVERSE_RELATION[row.type] ?? row.type }));
  const merged = new Map();
  for (const relation of [...direct, ...reverse]) {
    const key = `${relation.type}\u0000${relation.word.toLocaleLowerCase('id')}`;
    if (!merged.has(key) || merged.get(key).confidence < relation.confidence) merged.set(key, relation);
  }
  const candidates = [...merged.values()];
  const availability = db.prepare('SELECT slug FROM entries WHERE word = ? COLLATE NOCASE ORDER BY homonym LIMIT 1');
  return candidates.map((item) => ({
    ...item,
    slug: availability.get(item.word)?.slug ?? null,
    sourceLabel: item.source === 'wordnet-bahasa' ? 'WordNet Bahasa' : 'KBBI (eksplisit)'
  }));
}

function getWord(slug) {
  const row = db.prepare('SELECT * FROM entries WHERE slug = ?').get(slug);
  if (!row) return null;
  const entry = hydrateEntry(row);
  const relations = getRelations(entry.word);
  return {
    ...entry,
    wordClassLabel: CLASS_LABELS[entry.wordClass] ?? entry.wordClass,
    relations,
    relationGroups: Object.groupBy(relations, (item) => item.type)
  };
}

function randomWord() {
  const row = db.prepare('SELECT slug FROM entries ORDER BY RANDOM() LIMIT 1').get();
  return row ? getWord(row.slug) : null;
}

function serveStatic(requestPath, response) {
  const requested = requestPath === '/' ? 'index.html' : requestPath.replace(/^\/+/, '');
  const filePath = path.resolve(PUBLIC, requested);
  const publicRoot = path.resolve(PUBLIC);
  if (!filePath.startsWith(`${publicRoot}${path.sep}`) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return false;
  const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
  response.writeHead(200, {
    'content-type': `${types[path.extname(filePath)] || 'application/octet-stream'}; charset=utf-8`,
    'cache-control': path.extname(filePath) === '.html' ? 'no-cache' : 'public, max-age=3600'
  });
  fs.createReadStream(filePath).pipe(response);
  return true;
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  try {
    if (request.method !== 'GET') return json(response, { error: 'Metode tidak didukung' }, 405);
    if (url.pathname === '/api/health') return json(response, { ok: true, time: new Date().toISOString() });
    if (url.pathname === '/api/stats') return json(response, getStats());
    if (url.pathname === '/api/words') return json(response, listWords(url));
    if (url.pathname === '/api/random') {
      const item = randomWord();
      return item ? json(response, item) : json(response, { error: 'Basis data masih kosong' }, 404);
    }
    if (url.pathname.startsWith('/api/words/')) {
      const slug = decodeURIComponent(url.pathname.slice('/api/words/'.length));
      const item = getWord(slug);
      return item ? json(response, item) : json(response, { error: 'Kata tidak ditemukan' }, 404);
    }
    if (serveStatic(url.pathname, response)) return;
    json(response, { error: 'Halaman tidak ditemukan' }, 404);
  } catch (error) {
    console.error(error);
    json(response, { error: 'Terjadi kesalahan pada server' }, 500);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Ruang Kata aktif di http://${HOST}:${PORT}`);
});
