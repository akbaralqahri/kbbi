import { db, closeDb, setMeta } from '../lib/db.mjs';

const BASE = 'https://kbbi.web.id';
const WORDLIST_URL = 'https://raw.githubusercontent.com/dyazincahya/KBBI-SQL-database/main/edisi-IV/dictionary__JSON.json';
const APPLY = process.argv.includes('--apply');

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
  const words = new Set();
  for (const row of payload.dictionary ?? []) {
    const word = normalize(row.word);
    if (word) words.add(word);
  }
  for (const row of db.prepare('SELECT word FROM lexemes').all()) {
    const word = normalize(row.word);
    if (word) words.add(word);
  }
  return words;
}

function findCandidate(slug, words) {
  const value = normalize(slug);
  if (!value) return null;

  // URL homonim seperti "kata-2" sudah merupakan permalink yang sah.
  const homonym = value.match(/^(.*)-(\d+)$/);
  if (homonym && words.has(homonym[1])) return value;

  let best = null;
  for (let index = 2; index <= value.length; index += 1) {
    const prefix = value.slice(0, index).trimEnd();
    if (words.has(prefix)) best = prefix;
  }
  return best;
}

function main() {
  return loadCandidateWords().then((words) => {
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
      const candidate = findCandidate(row.slug, words);
      if (!candidate) {
        unmatched.push(row);
        continue;
      }
      const candidateUrl = `${BASE}/${candidate}`;
      repairs.push({
        ...row,
        candidate,
        candidateUrl,
        sameUrl: candidateUrl === row.url,
        existingState: existing.get(candidateUrl) ?? null
      });
    }

    const uniqueUrls = new Set(repairs.map((row) => row.candidateUrl));
    const newUrls = new Set(repairs.filter((row) => !row.existingState).map((row) => row.candidateUrl));
    const alreadyDone = new Set(repairs.filter((row) => row.existingState === 'done').map((row) => row.candidateUrl));
    console.log(JSON.stringify({
      mode: APPLY ? 'apply' : 'audit',
      candidateWords: words.size,
      problematicRows: rows.length,
      matchedRows: repairs.length,
      unmatchedRows: unmatched.length,
      uniqueCandidateUrls: uniqueUrls.size,
      newCandidateUrls: newUrls.size,
      alreadyDone: alreadyDone.size,
      sameUrlRetries: repairs.filter((row) => row.sameUrl && row.existingState !== 'done').length
    }, null, 2));

    console.log('\nContoh pemetaan:');
    for (const row of repairs.filter((item) => !item.sameUrl).slice(0, 25)) {
      console.log(`- ${row.slug} -> ${row.candidate}${row.existingState ? ` [${row.existingState}]` : ''}`);
    }
    if (unmatched.length) {
      console.log('\nContoh yang belum terpetakan:');
      for (const row of unmatched.slice(0, 20)) console.log(`- ${row.slug} (${row.last_error})`);
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
