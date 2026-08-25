import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, insertRelation, setMeta } from '../lib/db.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ID_DATA = path.join(ROOT, 'node_modules', 'id-wordnet', 'database', '1.2', 'wn-msa-all.tab');
const EN_DATA_DIR = path.join(ROOT, 'node_modules', 'wordnet', 'db');
const QUALITY = new Set(['Y', 'O']);
const RELATION_TYPES = new Map([
  ['!', 'antonim'],
  ['@', 'hipernim'], ['@i', 'hipernim'],
  ['~', 'hiponim'], ['~i', 'hiponim'],
  ['%m', 'meronim'], ['%s', 'meronim'], ['%p', 'meronim'],
  ['#m', 'holonim'], ['#s', 'holonim'], ['#p', 'holonim']
]);

function readIndonesianSynsets() {
  if (!fs.existsSync(ID_DATA)) throw new Error('Paket id-wordnet belum terpasang. Jalankan npm install.');
  const synsets = new Map();
  for (const line of fs.readFileSync(ID_DATA, 'utf8').split(/\r?\n/)) {
    if (!line) continue;
    const [synset, language, quality, ...lemmaParts] = line.split('\t');
    // B = Bahasa bersama (Indonesia/Melayu), I = khusus Indonesia.
    if (!['B', 'I'].includes(language) || !QUALITY.has(quality)) continue;
    const lemma = lemmaParts.join('\t').trim().replace(/_/g, ' ');
    if (!lemma) continue;
    if (!synsets.has(synset)) synsets.set(synset, new Set());
    synsets.get(synset).add(lemma);
  }
  return synsets;
}

function parsePointerTargets(synsets) {
  const links = [];
  const files = ['data.adj', 'data.adv', 'data.noun', 'data.verb'];
  for (const filename of files) {
    const filepath = path.join(EN_DATA_DIR, filename);
    if (!fs.existsSync(filepath)) continue;
    for (const line of fs.readFileSync(filepath, 'utf8').split(/\r?\n/)) {
      if (!/^\d{8}\s/.test(line)) continue;
      const data = line.split(' | ')[0].trim().split(/\s+/);
      const sourceOffset = data[0];
      const pos = data[2] === 's' ? 'a' : data[2];
      const sourceId = `${sourceOffset}-${pos}`;
      if (!synsets.has(sourceId)) continue;
      const wordCount = Number.parseInt(data[3], 16);
      let index = 4 + wordCount * 2;
      const pointerCount = Number.parseInt(data[index], 10);
      index += 1;
      for (let i = 0; i < pointerCount; i += 1) {
        const symbol = data[index];
        const targetOffset = data[index + 1];
        const targetPos = data[index + 2] === 's' ? 'a' : data[index + 2];
        const targetId = `${targetOffset}-${targetPos}`;
        index += 4;
        const type = RELATION_TYPES.get(symbol);
        if (type && synsets.has(targetId)) links.push({ sourceId, targetId, type });
      }
    }
  }
  return links;
}

function addPair(sourceWord, targetWord, type, synsetId, confidence = 0.9) {
  if (sourceWord.toLocaleLowerCase('id') === targetWord.toLocaleLowerCase('id')) return 0;
  return Number(insertRelation({
    sourceWord, targetWord, type, source: 'wordnet-bahasa', confidence, synsetId
  }).changes ?? 0);
}

function main() {
  const synsets = readIndonesianSynsets();
  const links = parsePointerTargets(synsets);
  console.log(`Mengimpor ${synsets.size.toLocaleString('id-ID')} synset Indonesia...`);
  db.exec("DELETE FROM relations WHERE source='wordnet-bahasa'");
  db.exec('BEGIN IMMEDIATE');
  let inserted = 0;
  try {
    for (const [synsetId, wordsSet] of synsets) {
      const words = [...wordsSet];
      for (let i = 0; i < words.length; i += 1) {
        for (let j = 0; j < words.length; j += 1) {
          if (i !== j) inserted += addPair(words[i], words[j], 'sinonim', synsetId, 0.94);
        }
      }
    }
    for (const { sourceId, targetId, type } of links) {
      for (const sourceWord of synsets.get(sourceId)) {
        for (const targetWord of synsets.get(targetId)) {
          inserted += addPair(sourceWord, targetWord, type, `${sourceId}>${targetId}`, type === 'antonim' ? 0.84 : 0.8);
        }
      }
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  setMeta('wordnet_synsets', synsets.size);
  setMeta('wordnet_relations', inserted);
  setMeta('wordnet_imported_at', new Date().toISOString());
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  console.log(`${inserted.toLocaleString('id-ID')} relasi berhasil diimpor.`);
}

main();
