import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDb, db, getMeta, hydrateEntry } from './lib/db.mjs';
import { LABEL_KIND_NAMES, WORD_CLASSES } from './lib/labels.mjs';
import { stripSenseHead } from './lib/parser.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || '127.0.0.1';
const STATS_TTL = 10_000;
const CLASS_LABELS = { ...Object.fromEntries(WORD_CLASSES), '': 'Tidak ditandai' };
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

let statsCache = { at: 0, value: null };

function computeStats() {
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
  const byLabel = db.prepare(`
    SELECT code, label, kind, COUNT(*) AS count FROM entry_labels
    GROUP BY code, label, kind ORDER BY count DESC
  `).all();
  return {
    entries: entryCount,
    lexemes: lexemeCount,
    queue: { ...queue, total: totalQueue },
    coverage: totalQueue ? ((queue.done || 0) + (queue.skipped || 0)) / totalQueue : 0,
    relations: Object.fromEntries(relationRows.map((row) => [row.type, row.count])),
    relationTotal: relationRows.reduce((sum, row) => sum + row.count, 0),
    byClass,
    byLetter,
    byLabel,
    labelKinds: LABEL_KIND_NAMES,
    crawl: {
      state: getMeta('crawl_state', 'idle'),
      sitemapFetchedAt: getMeta('sitemap_fetched_at'),
      lastActivityAt: getMeta('crawl_last_activity_at'),
      wordnetImportedAt: getMeta('wordnet_imported_at'),
      backfillAppliedAt: getMeta('backfill_applied_at')
    },
    edition: 'KBBI Daring Edisi III (arsip)'
  };
}

// Agregasi penuh memakan hampir satu detik dan dasbor menyegarkannya berkala,
// jadi hasilnya ditahan sebentar agar tidak memblokir permintaan lain.
function getStats() {
  const now = Date.now();
  if (statsCache.value && now - statsCache.at < STATS_TTL) return statsCache.value;
  statsCache = { at: now, value: computeStats() };
  return statsCache.value;
}

// FTS5 memerlukan kueri bertanda kutip agar tanda baca pengguna tidak ditafsirkan
// sebagai operator. Kata terakhir memakai awalan supaya saran ketik terasa hidup.
function ftsQuery(value) {
  const tokens = String(value).toLocaleLowerCase('id').match(/[\p{L}\p{N}]+/gu) ?? [];
  if (!tokens.length) return '';
  return tokens
    .map((token, index) => (index === tokens.length - 1 ? `"${token}"*` : `"${token}"`))
    .join(' AND ');
}

function buildQuery(url) {
  const q = (url.searchParams.get('q') || '').trim().slice(0, 100);
  const letter = (url.searchParams.get('letter') || '').trim().slice(0, 1);
  const wordClass = (url.searchParams.get('class') || '').trim().slice(0, 12);
  const label = (url.searchParams.get('label') || '').trim().slice(0, 24);
  const where = [];
  const params = [];
  let needsEntries = false;
  const match = q ? ftsQuery(q) : '';
  if (q) {
    if (match) {
      where.push('(l.word LIKE ? COLLATE NOCASE OR l.entry_slug IN (SELECT slug FROM entries_fts WHERE entries_fts MATCH ?))');
      params.push(`%${q}%`, match);
    } else {
      where.push('l.word LIKE ? COLLATE NOCASE');
      params.push(`%${q}%`);
    }
  }
  if (letter) { where.push('l.word LIKE ? COLLATE NOCASE'); params.push(`${letter}%`); }
  if (wordClass) { where.push('e.word_class = ?'); params.push(wordClass); needsEntries = true; }
  if (label) {
    where.push('EXISTS (SELECT 1 FROM entry_labels el WHERE el.entry_slug = l.entry_slug AND el.code = ?)');
    params.push(label);
  }
  return { q, letter, wordClass, label, where, params, needsEntries };
}

function listWords(url) {
  const limit = Math.min(60, Math.max(1, Number(url.searchParams.get('limit')) || 24));
  const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
  const { q, where, params, needsEntries } = buildQuery(url);
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const ranking = q
    ? `CASE WHEN LOWER(l.word)=LOWER(?) THEN 0
            WHEN l.word LIKE ? COLLATE NOCASE THEN 1
            WHEN l.word LIKE ? COLLATE NOCASE THEN 2
            ELSE 3 END,`
    : '';
  const rankParams = q ? [q, `${q}%`, `%${q}%`] : [];
  const rows = db.prepare(`
    SELECT e.slug, l.word, e.display_word, e.syllables, e.pronunciation, e.word_class,
      e.labels_json, e.definition_text, e.scraped_at, l.kind, l.meaning
    FROM lexemes l JOIN entries e ON e.slug = l.entry_slug ${whereSql}
    ORDER BY ${ranking} l.word COLLATE NOCASE, COALESCE(e.homonym, 0)
    LIMIT ? OFFSET ?
  `).all(...params, ...rankParams, limit, offset);
  // Tanpa penyaring tingkat entri, penghitungan tidak perlu menyentuh tabel entries.
  const total = needsEntries
    ? db.prepare(`SELECT COUNT(*) AS count FROM lexemes l JOIN entries e ON e.slug=l.entry_slug ${whereSql}`).get(...params).count
    : db.prepare(`SELECT COUNT(*) AS count FROM lexemes l ${whereSql}`).get(...params).count;
  return {
    items: rows.map((row) => ({
      slug: row.slug,
      word: row.word,
      displayWord: row.kind === 'lema' ? row.display_word : row.word,
      syllables: row.kind === 'lema' ? row.syllables : '',
      pronunciation: row.kind === 'lema' ? row.pronunciation : '',
      kind: row.kind,
      wordClass: row.word_class,
      wordClassLabel: CLASS_LABELS[row.word_class] ?? row.word_class,
      labels: row.kind === 'lema' ? safeLabels(row.labels_json) : [],
      summary: summaryFor(row),
      scrapedAt: row.scraped_at
    })),
    total, limit, offset, hasMore: offset + rows.length < total
  };
}

function safeLabels(value) {
  try { return JSON.parse(value); } catch { return []; }
}

// Makna pertama pada indeks lema sudah bersih sesudah `npm run backfill`, tetapi
// basis data lama masih menyimpan naskah mentah "ca·ha·ya n 1 sinar…". Pengupasan
// kepala lema dijalankan lagi di sini agar tampilan benar pada kedua keadaan.
function summaryFor(row) {
  const source = row.meaning?.trim() || String(row.definition_text || '');
  const stripped = stripSenseHead(source.replace(/\s+/g, ' '));
  return stripped.replace(/^\d+\s*/, '').slice(0, 220);
}

// WordNet mendaftarkan bentuk berimbuhan sebagai lema tersendiri, sedangkan KBBI
// menyimpannya di bawah lema induk. Pencarian tautan karena itu menelusuri tabel
// lexemes: "bercahaya" tidak punya entri sendiri, tetapi tercatat di entri
// "cahaya". Tanpa ini, hampir separuh relasi berakhir sebagai pil mati.
const relationSlugStmt = db.prepare(`
  SELECT l.entry_slug AS slug, l.kind, e.display_word AS host
  FROM lexemes l JOIN entries e ON e.slug = l.entry_slug
  WHERE l.word = ? COLLATE NOCASE
  ORDER BY CASE l.kind WHEN 'lema' THEN 0 ELSE 1 END, COALESCE(e.homonym, 0)
  LIMIT 1
`);

// Relasi milik bentuk turunan sebuah entri. Dipakai hanya ketika lema induknya
// sendiri tidak dikenal WordNet, dan selalu ditandai asalnya supaya tidak terbaca
// sebagai sinonim lema induk.
const derivedRelationStmt = db.prepare(`
  SELECT r.source_word AS via, r.target_word AS word, r.type, r.source, r.confidence, r.synset_id
  FROM lexemes l JOIN relations r ON r.source_word = l.word COLLATE NOCASE
  WHERE l.entry_slug = ? AND l.kind = 'turunan'
  ORDER BY r.confidence DESC, r.target_word
  LIMIT 90
`);

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
    const key = JSON.stringify([relation.type, relation.word.toLocaleLowerCase('id')]);
    if (!merged.has(key) || merged.get(key).confidence < relation.confidence) merged.set(key, relation);
  }
  return [...merged.values()].map(decorateRelation);
}

function decorateRelation(item) {
  const match = relationSlugStmt.get(item.word);
  return {
    ...item,
    slug: match?.slug ?? null,
    hostWord: match?.kind === 'turunan' ? match.host : null,
    sourceLabel: item.source === 'wordnet-bahasa' ? 'WordNet Bahasa' : 'KBBI (eksplisit)'
  };
}

function getDerivedRelations(slug) {
  const merged = new Map();
  for (const row of derivedRelationStmt.all(slug)) {
    const key = JSON.stringify([row.type, row.word.toLocaleLowerCase('id')]);
    if (!merged.has(key) || merged.get(key).confidence < row.confidence) merged.set(key, row);
  }
  return [...merged.values()].map((item) => ({ ...decorateRelation(item), derived: true }));
}

function getWord(slug) {
  const row = db.prepare('SELECT * FROM entries WHERE slug = ?').get(slug);
  if (!row) return null;
  const entry = hydrateEntry(row);
  const relations = getRelations(entry.word);
  const derivedRelations = relations.length ? [] : getDerivedRelations(entry.slug);
  return {
    ...entry,
    wordClassLabel: CLASS_LABELS[entry.wordClass] ?? entry.wordClass,
    relations,
    derivedRelations,
    relationGroups: Object.groupBy(relations, (item) => item.type),
    derivedRelationGroups: Object.groupBy(derivedRelations, (item) => item.type)
  };
}

function randomWord() {
  const row = db.prepare('SELECT slug FROM entries ORDER BY RANDOM() LIMIT 1').get();
  return row ? getWord(row.slug) : null;
}

// Berkas kode selalu divalidasi ulang lewat last-modified: menyimpannya satu jam
// membuat peramban menyajikan versi lama sesudah berkas diperbarui. Gambar boleh
// disimpan lama karena isinya tidak berubah tanpa berganti nama.
const MIME = {
  '.html': ['text/html', true, 'no-cache'], '.css': ['text/css', true, 'no-cache'],
  '.js': ['text/javascript', true, 'no-cache'], '.json': ['application/json', true, 'no-cache'],
  '.svg': ['image/svg+xml', true, 'public, max-age=86400'],
  '.png': ['image/png', false, 'public, max-age=86400'],
  '.ico': ['image/x-icon', false, 'public, max-age=86400'],
  '.webp': ['image/webp', false, 'public, max-age=86400'],
  '.woff2': ['font/woff2', false, 'public, max-age=604800']
};

// Peramban yang pernah menerima app.js atau styles.css dengan masa simpan panjang
// tidak akan menanyakannya lagi sampai masa itu habis, sehingga pembaruan kode
// tampak tidak berpengaruh. Cap waktu berkas disisipkan ke alamat aset agar
// setiap perubahan menghasilkan alamat baru yang pasti diambil ulang.
function stampAssets(html) {
  return html.replace(/\b(src|href)="\/([\w.-]+\.(?:js|css))"/g, (match, attribute, name) => {
    try {
      const version = Math.trunc(fs.statSync(path.join(PUBLIC, name)).mtimeMs).toString(36);
      return `${attribute}="/${name}?v=${version}"`;
    } catch {
      return match;
    }
  });
}

function serveDocument(filePath, request, response) {
  const body = Buffer.from(stampAssets(fs.readFileSync(filePath, 'utf8')), 'utf8');
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-cache'
  });
  response.end(request.method === 'HEAD' ? undefined : body);
  return true;
}

function serveStatic(requestPath, request, response) {
  const requested = requestPath === '/' ? 'index.html' : decodeURIComponent(requestPath).replace(/^\/+/, '');
  const filePath = path.resolve(PUBLIC, requested);
  const publicRoot = path.resolve(PUBLIC);
  if (!filePath.startsWith(`${publicRoot}${path.sep}`)) return false;
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;
  const extension = path.extname(filePath);
  // Naskah halaman tidak boleh dijawab 304 dari cap waktunya sendiri: isinya ikut
  // berubah ketika aset yang dirujuknya diperbarui.
  if (extension === '.html') return serveDocument(filePath, request, response);
  const [type, isText, cacheControl] = MIME[extension] ?? ['application/octet-stream', false, 'no-cache'];
  const lastModified = stat.mtime.toUTCString();
  if (request.headers['if-modified-since'] === lastModified) {
    response.writeHead(304, { 'cache-control': cacheControl }).end();
    return true;
  }
  response.writeHead(200, {
    'content-type': isText ? `${type}; charset=utf-8` : type,
    'content-length': stat.size,
    'last-modified': lastModified,
    'cache-control': cacheControl
  });
  if (request.method === 'HEAD') {
    response.end();
    return true;
  }
  const stream = fs.createReadStream(filePath);
  stream.on('error', () => response.destroy());
  stream.pipe(response);
  return true;
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  try {
    if (request.method !== 'GET' && request.method !== 'HEAD') return json(response, { error: 'Metode tidak didukung' }, 405);
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
    if (serveStatic(url.pathname, request, response)) return;
    json(response, { error: 'Halaman tidak ditemukan' }, 404);
  } catch (error) {
    console.error(error);
    json(response, { error: 'Terjadi kesalahan pada server' }, 500);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Ruang Kata aktif di http://${HOST}:${PORT}`);
});

// Penutupan tertib menuliskan kembali berkas WAL supaya basis data tidak
// meninggalkan sisa jurnal berukuran besar.
let closing = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    if (closing) return;
    closing = true;
    server.close(() => {
      closeDb();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 3_000).unref();
  });
}
