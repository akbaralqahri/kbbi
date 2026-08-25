import test from 'node:test';
import assert from 'node:assert/strict';
import { extractElementInnerById, parseEntryPage, parseSitemap } from '../lib/parser.mjs';
import { decodeHtml, sanitizeDefinition, slugFromUrl } from '../lib/text.mjs';

const FIXTURE = `<!doctype html><html><body>
  <div id="desc">
    <div id="d1"><b>ca&#183;ha&#183;ya</b> <em>n</em> <b>1</b> sinar yang memungkinkan mata melihat; <b>2</b> kilau gemerlap;<br/>
      <b>-- mata</b> <b>1</b> sinar mata; <b>2</b> <em>ki</em> kekasih;<br/>
      <b>ber&#183;ca&#183;ha&#183;ya</b> <em>v</em> memancarkan cahaya;
      <div class="sumber">Definisi eksternal</div>
    </div>
  </div>
  <script>alert('tidak boleh ikut')</script>
</body></html>`;

test('mengambil elemen bersarang secara utuh', () => {
  const inner = extractElementInnerById(FIXTURE, 'd1');
  assert.match(inner, /Definisi eksternal/);
  assert.doesNotMatch(inner, /tidak boleh ikut/);
});

test('mengurai lema, makna, dan bentuk turunan', () => {
  const result = parseEntryPage(FIXTURE, { slug: 'cahaya', sourceUrl: 'https://kbbi.web.id/cahaya' });
  assert.equal(result.word, 'cahaya');
  assert.equal(result.syllables, 'ca·ha·ya');
  assert.equal(result.wordClass, 'n');
  assert.equal(result.senses.length, 2);
  assert.deepEqual(result.derivatives.map((item) => item.word), ['cahaya mata', 'bercahaya']);
  assert.doesNotMatch(result.definitionHtml, /script|alert/i);
});

test('sitemap dan entitas HTML dinormalisasi', () => {
  assert.deepEqual(parseSitemap('<urlset><loc>https://kbbi.web.id/rumah%20adat</loc><loc>https://lain.id/a</loc></urlset>'), ['https://kbbi.web.id/rumah%20adat']);
  assert.equal(slugFromUrl('https://kbbi.web.id/rumah%20adat'), 'rumah adat');
  assert.equal(decodeHtml('A &amp; B &#183; C'), 'A & B · C');
});

test('sanitizer hanya mempertahankan markup definisi aman', () => {
  const clean = sanitizeDefinition('<b onclick="x()">kata</b><img src=x onerror=x><script>x()</script><em>n</em>');
  assert.equal(clean, '<b>kata</b><em>n</em>');
});
