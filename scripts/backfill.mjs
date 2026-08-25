// Memugar entri yang sudah tersimpan dengan membaca ulang naskah definisi di
// basis data. Tidak ada permintaan jaringan: seluruh bahan sudah ada di kolom
// definition_html, sehingga hasil crawl lama tidak perlu diambil ulang.
import { closeDb, db, entrySummary, setMeta, writeEntry } from '../lib/db.mjs';
import { parseDefinition } from '../lib/parser.mjs';
import { safeJson } from '../lib/text.mjs';

const APPLY = process.argv.includes('--apply');
const BATCH = 500;

function sameLabels(before, after) {
  const a = before.map((item) => item.code).sort().join('|');
  const b = after.map((item) => item.code).sort().join('|');
  return a === b;
}

function main() {
  const rows = db.prepare(`
    SELECT slug, word, word_class, pronunciation, labels_json, senses_json,
      derivatives_json, definition_html, definition_text, source_url, scraped_at
    FROM entries ORDER BY slug
  `).all();

  const report = {
    mode: APPLY ? 'apply' : 'audit',
    entriesScanned: rows.length,
    parseFailed: 0,
    classGained: 0,
    classCorrected: 0,
    classLost: 0,
    labelsAdded: 0,
    pronunciationAdded: 0,
    sensesCleaned: 0,
    summaryCleaned: 0,
    entriesChanged: 0
  };
  const samples = { kelas: [], label: [], makna: [], hilang: [] };
  const pending = [];

  const currentSummaries = new Map(
    db.prepare("SELECT entry_slug, meaning FROM lexemes WHERE kind='lema'").all()
      .map((row) => [row.entry_slug, row.meaning])
  );

  for (const row of rows) {
    let entry;
    try {
      entry = parseDefinition(row.definition_html, { slug: row.slug, sourceUrl: row.source_url });
    } catch {
      report.parseFailed += 1;
      continue;
    }
    entry.scrapedAt = row.scraped_at;

    const oldLabels = safeJson(row.labels_json);
    const oldSenses = safeJson(row.senses_json);
    const oldFirstSense = oldSenses[0]?.text ?? '';
    const newFirstSense = entry.senses[0]?.text ?? '';
    const oldSummary = currentSummaries.get(row.slug) ?? '';

    let changed = false;
    if (!row.word_class && entry.wordClass) {
      report.classGained += 1;
      changed = true;
      if (samples.kelas.length < 6) samples.kelas.push(`${row.word}: (kosong) -> ${entry.wordClass}`);
    } else if (row.word_class && entry.wordClass && row.word_class !== entry.wordClass) {
      report.classCorrected += 1;
      changed = true;
    } else if (row.word_class && !entry.wordClass) {
      report.classLost += 1;
      changed = true;
      if (samples.hilang.length < 6) samples.hilang.push(`${row.word}: ${row.word_class} -> (kosong)`);
    }
    if (entry.labels.length && !sameLabels(oldLabels, entry.labels)) {
      report.labelsAdded += 1;
      changed = true;
      if (samples.label.length < 6) samples.label.push(`${row.word}: ${entry.labels.map((item) => item.label).join(', ')}`);
    }
    if (entry.pronunciation && entry.pronunciation !== row.pronunciation) {
      report.pronunciationAdded += 1;
      changed = true;
    }
    if (newFirstSense !== oldFirstSense) {
      report.sensesCleaned += 1;
      changed = true;
      if (samples.makna.length < 6) samples.makna.push(`${row.word}:\n      lama: ${oldFirstSense.slice(0, 88)}\n      baru: ${newFirstSense.slice(0, 88)}`);
    }
    if (entrySummary(entry) !== oldSummary) {
      report.summaryCleaned += 1;
      changed = true;
    }
    if (changed) {
      report.entriesChanged += 1;
      if (APPLY) pending.push(entry);
    }
  }

  console.log(JSON.stringify(report, null, 2));
  console.log('\nContoh kelas kata yang dipulihkan:');
  for (const line of samples.kelas) console.log(`  - ${line}`);
  console.log('\nContoh label baru:');
  for (const line of samples.label) console.log(`  - ${line}`);
  console.log('\nContoh makna yang dibersihkan:');
  for (const line of samples.makna) console.log(`  - ${line}`);
  if (samples.hilang.length) {
    console.log('\nPerhatian, kelas kata yang justru hilang:');
    for (const line of samples.hilang) console.log(`  - ${line}`);
  }

  if (!APPLY) {
    console.log('\nMode audit; basis data tidak diubah. Jalankan ulang dengan --apply untuk menerapkan.');
    return;
  }

  let written = 0;
  for (let index = 0; index < pending.length; index += BATCH) {
    const batch = pending.slice(index, index + BATCH);
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const entry of batch) writeEntry(entry);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    written += batch.length;
    if (written % 5000 === 0 || written === pending.length) console.log(`  ${written}/${pending.length} entri ditulis ulang`);
  }
  setMeta('backfill_applied_at', new Date().toISOString());
  setMeta('backfill_entries_rewritten', written);
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.exec('ANALYZE');
  console.log(`\nSelesai. ${written} entri diperbarui.`);
}

try {
  main();
} finally {
  closeDb();
}
