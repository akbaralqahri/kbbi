import { db, closeDb, setMeta } from '../lib/db.mjs';

const BASE = 'https://kbbi.web.id';
const WORDLIST_URL = 'https://raw.githubusercontent.com/dyazincahya/KBBI-SQL-database/main/edisi-IV/dictionary__JSON.json';
const APPLY = process.argv.includes('--apply');
// Prefiks slug rusak hanya menemukan sebagian lema yang hilang. Mode ini
// mengantre setiap kata daftar acuan yang belum ada di koleksi, sehingga
// alamat seperti /adik dan /amnesia ikut diminta. Naskah definisinya tetap
// diambil dari kbbi.web.id; daftar acuan hanya dipakai untuk menebak alamat.
const PROBE = process.argv.includes('--probe-wordlist');

function normalize(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase('id-ID')
    .replace(/\s+/g, ' ')
    .trim();
}

async function loadCandidateWords() {
  const response = await fetch(WORDLIST_URL, {
    headers: { 'user-agent': 'RuangKata/1.0 (sitemap repair; word-list use only)' },
    signal: AbortSignal.timeout(180_000)
  });
  if (!response.ok) throw new Error(`Gagal mengambil daftar kata pembantu: HTTP ${response.status}`);
  const payload = await response.json();
  const reference = new Set();
  for (const row of payload.dictionary ?? []) {
    const word = normalize(row.word);
    if (word) reference.add(word);
  }
  const known = new Set();
  for (const row of db.prepare('SELECT word FROM lexemes').all()) {
    const word = normalize(row.word);
    if (word) known.add(word);
  }
  return { words: new Set([...reference, ...known]), reference, known };
}

// Kata daftar acuan yang sama sekali belum ada di koleksi dan alamatnya belum
// pernah diantre. Alamat dengan spasi dibiarkan apa adanya; pengambil akan
// menyandikannya sendiri.
function missingReferenceWords(reference, known, existing) {
  const missing = [];
  for (const word of reference) {
    if (known.has(word) || existing.has(`${BASE}/${word}`)) continue;
    missing.push(word);
  }
  return missing;
}

// Satu slug rusak dapat memuat beberapa lema yang sah sekaligus. Pada
// "adikadik bungsuadik ipar…" prefiks yang dikenal adalah "adi", "adik", dan
// "adika"; mengambil yang terpanjang saja membuat "adik" tidak pernah diminta.
// Karena itu semua prefiks dikembalikan, bukan hanya satu.
function findCandidates(slug, words) {
  const value = normalize(slug);
  if (!value) return [];

  // URL homonim seperti "kata-2" sudah merupakan permalink yang sah.
  const homonym = value.match(/^(.*)-(\d+)$/);
  if (homonym && words.has(homonym[1])) return [value];

  const found = new Set();
  for (let index = 2; index <= value.length; index += 1) {
    const prefix = value.slice(0, index).trimEnd();
    if (words.has(prefix)) found.add(prefix);
  }
  return [...found];
}

function main() {
  return loadCandidateWords().then(({ words, reference, known }) => {
    const rows = db.prepare(`
      SELECT url, slug, state, attempts, last_error
      FROM crawl_queue
      WHERE state IN ('skipped', 'error')
      ORDER BY slug COLLATE NOCASE
    `).all();
    const existing = new Map(db.prepare('SELECT url, state FROM crawl_queue').all().map((row) => [row.url, row.state]));
    const repairs = [];
    const unmatched = [];

    for (const row of rows) {
      const candidates = findCandidates(row.slug, words);
      if (!candidates.length) {
        unmatched.push(row);
        continue;
      }
      for (const candidate of candidates) {
        const candidateUrl = `${BASE}/${candidate}`;
        repairs.push({
          ...row,
          candidate,
          candidateUrl,
          sameUrl: candidateUrl === row.url,
          existingState: existing.get(candidateUrl) ?? null
        });
      }
    }

    const probes = PROBE ? missingReferenceWords(reference, known, new Set(existing.keys())) : [];

    const uniqueUrls = new Set(repairs.map((row) => row.candidateUrl));
    const newUrls = new Set(repairs.filter((row) => !row.existingState).map((row) => row.candidateUrl));
    const alreadyDone = new Set(repairs.filter((row) => row.existingState === 'done').map((row) => row.candidateUrl));
    console.log(JSON.stringify({
      mode: APPLY ? 'apply' : 'audit',
      candidateWords: words.size,
      problematicRows: rows.length,
      matchedRows: new Set(repairs.map((row) => row.slug)).size,
      totalCandidatePairs: repairs.length,
      unmatchedRows: unmatched.length,
      uniqueCandidateUrls: uniqueUrls.size,
      newCandidateUrls: newUrls.size,
      alreadyDone: alreadyDone.size,
      sameUrlRetries: repairs.filter((row) => row.sameUrl && row.existingState !== 'done').length,
      wordlistProbes: PROBE ? probes.length : '(nonaktif; pakai --probe-wordlist)'
    }, null, 2));

    console.log('\nContoh pemetaan:');
    for (const row of repairs.filter((item) => !item.sameUrl).slice(0, 25)) {
      console.log(`- ${row.slug} -> ${row.candidate}${row.existingState ? ` [${row.existingState}]` : ''}`);
    }
    if (unmatched.length) {
      console.log('\nContoh yang belum terpetakan:');
      for (const row of unmatched.slice(0, 20)) console.log(`- ${row.slug} (${row.last_error})`);
    }

    if (PROBE) {
      console.log(`\nPenyisiran daftar acuan: ${probes.length} alamat baru. Contoh:`);
      for (const word of probes.slice(0, 15)) console.log(`- ${word}`);
      console.log(`Perkiraan crawl pada jeda 1,5 detik: sekitar ${(probes.length * 1.5 / 3600).toFixed(1)} jam.`);
    }

    if (!APPLY) {
      console.log('\nAudit saja; jalankan kembali dengan --apply untuk memperbarui antrean.');
      return;
    }

    const now = new Date().toISOString();
    const insert = db.prepare(`
      INSERT OR IGNORE INTO crawl_queue(url, slug, state, attempts, last_error, queued_at, updated_at)
      VALUES (?, ?, 'pending', 0, NULL, ?, ?)
    `);
    const retry = db.prepare(`
      UPDATE crawl_queue
      SET state='pending', last_error=NULL, updated_at=?
      WHERE url=? AND state IN ('skipped','error') AND attempts < 5
    `);
    let inserted = 0;
    let reset = 0;
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of repairs) {
        if (row.existingState === 'done') continue;
        // Halaman yang sudah pernah menghasilkan "tidak ditemukan" tidak perlu
        // langsung diulang. URL turunan hasil perbaikan dan error koneksi tetap
        // diaktifkan kembali.
        if ((row.sameUrl && row.existingState === 'error') || (!row.sameUrl && row.existingState)) {
          reset += Number(retry.run(now, row.candidateUrl).changes);
        } else if (!row.sameUrl) {
          inserted += Number(insert.run(row.candidateUrl, row.candidate, now, now).changes);
        }
      }
      for (const word of probes) inserted += Number(insert.run(`${BASE}/${word}`, word, now, now).changes);
      setMeta('sitemap_repair_probes', probes.length);
      setMeta('sitemap_repair_source', WORDLIST_URL);
      setMeta('sitemap_repair_applied_at', now);
      setMeta('sitemap_repair_inserted', inserted);
      setMeta('sitemap_repair_reset', reset);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    console.log(`\nAntrean diperbaiki: ${inserted} URL baru, ${reset} URL diaktifkan kembali.`);
  });
}

try {
  await main();
} finally {
  closeDb();
}
