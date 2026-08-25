import { db, DB_PATH } from '../lib/db.mjs';

const entries = db.prepare('SELECT COUNT(*) AS count FROM entries').get().count;
const queue = db.prepare('SELECT state, COUNT(*) AS count FROM crawl_queue GROUP BY state ORDER BY state').all();
const relations = db.prepare('SELECT type, COUNT(*) AS count FROM relations GROUP BY type ORDER BY count DESC').all();
const meta = Object.fromEntries(db.prepare('SELECT key, value FROM metadata ORDER BY key').all().map((row) => [row.key, row.value]));

console.log(JSON.stringify({ database: DB_PATH, entries, queue, relations, metadata: meta }, null, 2));
