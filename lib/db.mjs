import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { normalizeWord, safeJson } from './text.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DB_PATH = process.env.KBBI_DB_PATH || path.join(ROOT, 'data', 'kbbi.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;

  CREATE TABLE IF NOT EXISTS metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS entries (
    slug TEXT PRIMARY KEY,
    word TEXT NOT NULL,
    display_word TEXT NOT NULL,
    syllables TEXT,
    homonym INTEGER,
    word_class TEXT,
    definition_html TEXT NOT NULL,
    definition_text TEXT NOT NULL,
    senses_json TEXT NOT NULL DEFAULT '[]',
    derivatives_json TEXT NOT NULL DEFAULT '[]',
    source_url TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    scraped_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS entries_word_idx ON entries(word COLLATE NOCASE);
  CREATE INDEX IF NOT EXISTS entries_class_idx ON entries(word_class);

  CREATE TABLE IF NOT EXISTS lexemes (
    word TEXT NOT NULL COLLATE NOCASE,
    entry_slug TEXT NOT NULL,
    kind TEXT NOT NULL,
    meaning TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (word, entry_slug, kind),
    FOREIGN KEY (entry_slug) REFERENCES entries(slug) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS lexemes_word_idx ON lexemes(word COLLATE NOCASE);
  CREATE INDEX IF NOT EXISTS lexemes_slug_idx ON lexemes(entry_slug);

  CREATE TABLE IF NOT EXISTS crawl_queue (
    url TEXT PRIMARY KEY,
    slug TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    queued_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS crawl_queue_state_idx ON crawl_queue(state, updated_at);

  CREATE TABLE IF NOT EXISTS relations (
    source_word TEXT NOT NULL COLLATE NOCASE,
    target_word TEXT NOT NULL COLLATE NOCASE,
    type TEXT NOT NULL,
    source TEXT NOT NULL,
    confidence REAL NOT NULL DEFAULT 1,
    synset_id TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (source_word, target_word, type, source, synset_id)
  );
  CREATE INDEX IF NOT EXISTS relations_source_idx ON relations(source_word COLLATE NOCASE, type);
  CREATE INDEX IF NOT EXISTS relations_target_idx ON relations(target_word COLLATE NOCASE, type);

  CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
    slug UNINDEXED,
    word,
    definition_text,
    tokenize='unicode61 remove_diacritics 2'
  );
`);

const upsertEntryStmt = db.prepare(`
  INSERT INTO entries (
    slug, word, display_word, syllables, homonym, word_class, definition_html,
    definition_text, senses_json, derivatives_json, source_url, content_hash, scraped_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(slug) DO UPDATE SET
    word=excluded.word, display_word=excluded.display_word, syllables=excluded.syllables,
    homonym=excluded.homonym, word_class=excluded.word_class,
    definition_html=excluded.definition_html, definition_text=excluded.definition_text,
    senses_json=excluded.senses_json, derivatives_json=excluded.derivatives_json,
    source_url=excluded.source_url, content_hash=excluded.content_hash,
    scraped_at=excluded.scraped_at
`);

const deleteFtsStmt = db.prepare('DELETE FROM entries_fts WHERE slug = ?');
const insertFtsStmt = db.prepare('INSERT INTO entries_fts(slug, word, definition_text) VALUES (?, ?, ?)');
const deleteLexemesStmt = db.prepare('DELETE FROM lexemes WHERE entry_slug = ?');
const insertLexemeStmt = db.prepare('INSERT OR REPLACE INTO lexemes(word, entry_slug, kind, meaning) VALUES (?, ?, ?, ?)');
const insertRelationStmt = db.prepare(`
  INSERT OR IGNORE INTO relations(source_word, target_word, type, source, confidence, synset_id)
  VALUES (?, ?, ?, ?, ?, ?)
`);

export function upsertEntry(entry) {
  db.exec('BEGIN IMMEDIATE');
  try {
    upsertEntryStmt.run(
      entry.slug, entry.word, entry.displayWord, entry.syllables, entry.homonym,
      entry.wordClass, entry.definitionHtml, entry.definitionText,
      JSON.stringify(entry.senses), JSON.stringify(entry.derivatives), entry.sourceUrl,
      entry.contentHash, new Date().toISOString()
    );
    deleteFtsStmt.run(entry.slug);
    insertFtsStmt.run(entry.slug, entry.word, entry.definitionText);
    deleteLexemesStmt.run(entry.slug);
    insertLexemeStmt.run(entry.word, entry.slug, 'lema', entry.senses?.[0]?.text ?? entry.definitionText.slice(0, 500));
    for (const derivative of entry.derivatives ?? []) {
      insertLexemeStmt.run(derivative.word, entry.slug, 'turunan', derivative.meaning);
    }
    for (const relation of entry.relations ?? []) {
      insertRelationStmt.run(entry.word, relation.target, relation.type, relation.source, relation.confidence, '');
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

// Basis data dari versi awal otomatis mendapat indeks bentuk turunan saat pertama dibuka.
if (db.prepare('SELECT COUNT(*) AS count FROM lexemes').get().count === 0) {
  const existing = db.prepare('SELECT slug, word, definition_text, derivatives_json FROM entries').all();
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const row of existing) {
      insertLexemeStmt.run(row.word, row.slug, 'lema', row.definition_text.slice(0, 500));
      for (const derivative of safeJson(row.derivatives_json)) {
        insertLexemeStmt.run(normalizeWord(derivative.word), row.slug, 'turunan', derivative.meaning ?? '');
      }
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

// Migrasi ringan untuk indeks lama yang masih menyimpan tanda pemenggalan suku kata.
const dottedLexemes = db.prepare("SELECT word, entry_slug, kind, meaning FROM lexemes WHERE word LIKE '%·%'").all();
if (dottedLexemes.length) {
  const removeLexeme = db.prepare('DELETE FROM lexemes WHERE word=? AND entry_slug=? AND kind=?');
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const row of dottedLexemes) {
      removeLexeme.run(row.word, row.entry_slug, row.kind);
      insertLexemeStmt.run(normalizeWord(row.word), row.entry_slug, row.kind, row.meaning);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function insertRelation(relation) {
  return insertRelationStmt.run(
    relation.sourceWord, relation.targetWord, relation.type, relation.source,
    relation.confidence ?? 1, relation.synsetId ?? ''
  );
}

export function setMeta(key, value) {
  db.prepare(`
    INSERT INTO metadata(key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
  `).run(key, String(value), new Date().toISOString());
}

export function getMeta(key, fallback = null) {
  return db.prepare('SELECT value FROM metadata WHERE key = ?').get(key)?.value ?? fallback;
}

export function hydrateEntry(row) {
  if (!row) return null;
  return {
    slug: row.slug,
    word: row.word,
    displayWord: row.display_word,
    syllables: row.syllables,
    homonym: row.homonym,
    wordClass: row.word_class,
    definitionHtml: row.definition_html,
    definitionText: row.definition_text,
    senses: safeJson(row.senses_json),
    derivatives: safeJson(row.derivatives_json),
    sourceUrl: row.source_url,
    scrapedAt: row.scraped_at
  };
}

export function closeDb() {
  db.close();
}
