import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB_PATH = path.join(os.tmpdir(), `ruang-kata-uji-${process.pid}.db`);
const PORT = 40000 + (process.pid % 20000);
const BASE = `http://127.0.0.1:${PORT}`;

process.env.KBBI_DB_PATH = DB_PATH;

const { upsertEntry, closeDb } = await import('../lib/db.mjs');
const { parseDefinition } = await import('../lib/parser.mjs');

const FIXTURES = [
  ['cahaya', '<b>ca·ha·ya</b> <em>n</em> <b>1</b> sinar atau terang; <b>2</b> kilau gemerlap;<br><b>-- mata</b> kekasih'],
  ['afdeling', '<b>af·de·ling</b> /afdéling/ <em>Bld n</em> seksi; bagian; divisi'],
  ['abangan', '<b>a·ba·ngan</b> <em>Jw n</em> golongan penganut agama yang tidak taat']
];

for (const [slug, html] of FIXTURES) {
  upsertEntry(parseDefinition(html, { slug, sourceUrl: `https://kbbi.web.id/${slug}` }));
}

const server = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' },
  stdio: 'ignore'
});

async function waitForServer() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${BASE}/api/health`);
      if (response.ok) return;
    } catch { /* server belum siap. */ }
    await sleep(150);
  }
  throw new Error('Server uji tidak kunjung siap.');
}

await waitForServer();

test.after(() => {
  server.kill();
  closeDb();
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(`${DB_PATH}${suffix}`); } catch { /* berkas mungkin sudah hilang. */ }
  }
});

const api = async (pathname) => {
  const response = await fetch(`${BASE}${pathname}`);
  return { status: response.status, body: await response.json() };
};

test('ringkasan kartu tidak lagi memuat kepala lema bertitik', async () => {
  const { body } = await api('/api/words?q=cahaya&limit=5');
  const lema = body.items.find((item) => item.kind === 'lema');
  assert.equal(lema.summary, 'sinar atau terang;');
  assert.doesNotMatch(lema.summary, /·/);
});

test('pencarian menemukan kata lewat naskah definisi', async () => {
  const { body } = await api('/api/words?q=gemerlap');
  assert.ok(body.total > 0);
  assert.ok(body.items.some((item) => item.word === 'cahaya'));
});

test('pencarian mengutamakan kecocokan persis pada lema', async () => {
  const { body } = await api('/api/words?q=cahaya&limit=5');
  assert.equal(body.items[0].word, 'cahaya');
});

test('penyaring label menyaring berdasarkan bidang atau bahasa asal', async () => {
  const { body } = await api('/api/words?label=jw');
  assert.equal(body.total, 1);
  assert.equal(body.items[0].word, 'abangan');
  const kosong = await api('/api/words?label=kim');
  assert.equal(kosong.body.total, 0);
});

test('statistik memuat rekap label dan kelas kata', async () => {
  const { body } = await api('/api/stats');
  assert.equal(body.entries, 3);
  const kode = body.byLabel.map((item) => item.code).sort();
  assert.deepEqual(kode, ['bld', 'jw']);
  assert.ok(body.byClass.some((item) => item.code === 'n' && item.count > 0));
});

test('entri tunggal memuat lafal, label, dan kelompok relasi', async () => {
  const { body } = await api('/api/words/afdeling');
  assert.equal(body.pronunciation, 'afdéling');
  assert.equal(body.wordClassLabel, 'Nomina');
  assert.deepEqual(body.labels.map((item) => item.label), ['Belanda']);
  assert.ok(body.relationGroups);
});

test('kata yang tidak ada menghasilkan 404, bukan galat server', async () => {
  const { status, body } = await api('/api/words/entah-apa-ini');
  assert.equal(status, 404);
  assert.ok(body.error);
});

test('tanda baca pada kueri tidak merusak pencarian teks penuh', async () => {
  for (const q of ['"', 'AND', 'cahaya OR', '((', '*', 'a-b']) {
    const response = await fetch(`${BASE}/api/words?q=${encodeURIComponent(q)}`);
    assert.equal(response.status, 200, `kueri ${q} gagal`);
    assert.ok(Array.isArray((await response.json()).items));
  }
});

test('berkas di luar folder publik tidak dapat diambil', async () => {
  for (const target of ['/../server.mjs', '/%2e%2e/server.mjs', '/..%2fserver.mjs']) {
    const response = await fetch(`${BASE}${target}`);
    assert.equal(response.status, 404, `${target} seharusnya tidak dilayani`);
  }
});

test('metode selain GET dan HEAD ditolak', async () => {
  const response = await fetch(`${BASE}/api/stats`, { method: 'POST' });
  assert.equal(response.status, 405);
});

test('alamat aset diberi cap versi agar salinan lama peramban tidak terpakai', async () => {
  const response = await fetch(`${BASE}/`);
  assert.equal(response.headers.get('cache-control'), 'no-cache');
  const html = await response.text();
  assert.match(html, /src="\/app\.js\?v=[a-z0-9]+"/);
  assert.match(html, /href="\/styles\.css\?v=[a-z0-9]+"/);
  assert.doesNotMatch(html, /src="\/app\.js"/);
});

test('cap versi berubah ketika berkas aset diperbarui', async () => {
  const assetPath = path.join(ROOT, 'public', 'app.js');
  const versionOf = async () => /app\.js\?v=([a-z0-9]+)/.exec(await (await fetch(`${BASE}/`)).text())?.[1];
  const before = await versionOf();
  const original = fs.statSync(assetPath);
  try {
    fs.utimesSync(assetPath, original.atime, new Date(original.mtime.getTime() + 60_000));
    assert.notEqual(await versionOf(), before);
  } finally {
    fs.utimesSync(assetPath, original.atime, original.mtime);
  }
  assert.equal(await versionOf(), before);
});

test('aset beralamat versi tetap dilayani dengan tipe yang benar', async () => {
  const response = await fetch(`${BASE}/app.js?v=zzz`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/javascript/);
});
