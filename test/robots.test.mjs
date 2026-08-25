import test from 'node:test';
import assert from 'node:assert/strict';
import { isAllowed, parseRobots } from '../lib/robots.mjs';

test('aturan per-alamat dibaca, bukan hanya larangan seluruh situs', () => {
  const robots = parseRobots('User-agent: *\nDisallow: /admin\nDisallow: /tmp/\nAllow: /tmp/publik\n');
  assert.equal(robots.blocksEverything, false);
  assert.equal(isAllowed(robots, '/cahaya'), true);
  assert.equal(isAllowed(robots, '/admin/masuk'), false);
  assert.equal(isAllowed(robots, '/tmp/rahasia'), false);
  assert.equal(isAllowed(robots, '/tmp/publik/berkas'), true);
});

test('larangan blok agen lain tidak menular ke blok bintang', () => {
  const robots = parseRobots('User-agent: *\nDisallow: /admin\n\nUser-agent: BadBot\nDisallow: /\n');
  assert.equal(robots.blocksEverything, false);
  assert.equal(isAllowed(robots, '/cahaya'), true);
});

test('larangan seluruh situs pada blok bintang terdeteksi', () => {
  assert.equal(parseRobots('User-agent: *\nDisallow: /\n').blocksEverything, true);
  assert.equal(parseRobots('User-agent: *\nAllow: /\n').blocksEverything, false);
});

test('Disallow kosong berarti mengizinkan', () => {
  const robots = parseRobots('User-agent: *\nDisallow:\n');
  assert.equal(robots.blocksEverything, false);
  assert.equal(isAllowed(robots, '/apa pun'), true);
});

test('tanda bintang dan dolar pada pola dihormati', () => {
  const robots = parseRobots('User-agent: *\nDisallow: /*.pdf$\nDisallow: /cari?*\n');
  assert.equal(isAllowed(robots, '/berkas/panduan.pdf'), false);
  assert.equal(isAllowed(robots, '/berkas/panduan.pdf.html'), true);
  assert.equal(isAllowed(robots, '/cari?q=rumah'), false);
});

test('blok khusus agen mengalahkan blok bintang', () => {
  const robots = parseRobots('User-agent: *\nDisallow: /\n\nUser-agent: ruangkata\nDisallow: /admin\n', 'RuangKata/1.0');
  assert.equal(robots.blocksEverything, false);
  assert.equal(isAllowed(robots, '/cahaya'), true);
  assert.equal(isAllowed(robots, '/admin'), false);
});

test('crawl-delay terbaca dan komentar diabaikan', () => {
  const robots = parseRobots('# catatan\nUser-agent: *\nCrawl-delay: 2.5\nDisallow: /admin # alasan\n');
  assert.equal(robots.crawlDelay, 2.5);
  assert.equal(isAllowed(robots, '/admin'), false);
});

test('beberapa baris User-agent berurutan berbagi satu blok aturan', () => {
  const robots = parseRobots('User-agent: A\nUser-agent: *\nDisallow: /admin\n');
  assert.equal(isAllowed(robots, '/admin'), false);
  assert.equal(isAllowed(robots, '/cahaya'), true);
});
