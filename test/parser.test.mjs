import test from 'node:test';
import assert from 'node:assert/strict';
import { extractElementInnerById, extractMarkers, parseDefinition, parseEntryPage, parseSitemap, stripSenseHead } from '../lib/parser.mjs';
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

const parse = (html) => parseDefinition(html, { slug: 'uji', sourceUrl: 'https://kbbi.web.id/uji' });

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

test('kelas kata terbaca meski label bergabung dengan bidang atau bahasa asal', () => {
  assert.deepEqual(extractMarkers('<b>gu·rub</b> <em>Ar v</em> jatuh; runtuh').wordClass, 'v');
  assert.deepEqual(extractMarkers('<b>ab·do·men</b> <em>n Bio</em> perut').wordClass, 'n');
  assert.deepEqual(extractMarkers('<b>a·ba·ngan</b> <em>Jw n</em> golongan').wordClass, 'n');
});

test('label bidang, ragam, dan bahasa asal ikut tercatat', () => {
  const { labels } = extractMarkers('<b>ab·dom·en</b> <em>n Bio</em> perut');
  assert.deepEqual(labels, [{ code: 'bio', label: 'Biologi', kind: 'bidang' }]);
  const jawa = extractMarkers('<b>a·ba·ngan</b> <em>Jw n cak</em> golongan');
  assert.deepEqual(jawa.labels.map((item) => item.label), ['Jawa', 'Cakapan']);
});

test('kalimat contoh bercetak miring tidak terbaca sebagai label', () => {
  const markers = extractMarkers('<b>ga·bah</b> n butir padi: <em>merpati itu diberi pakan jagung dicampur --</em>');
  assert.equal(markers.wordClass, 'n');
  assert.deepEqual(markers.labels, []);
});

test('kelas kata pada bentuk berimbuhan serangkai tetap terbaca', () => {
  assert.equal(extractMarkers('<b>acau</b>, <b>meng·a·cau</b> <em>v</em> berkata tidak keruan').wordClass, 'v');
  assert.equal(extractMarkers('<b>ba·ha·gia</b> <b>1</b> <em>n</em> keadaan senang').wordClass, 'n');
});

test('kelas kata bentuk turunan sesudah <br> tidak diambil untuk lema induk', () => {
  const markers = extractMarkers('<b>angin barat</b> <em>Geo</em> arus dingin<br><b>meng·a·ngin</b> <em>v</em> meniup');
  assert.equal(markers.wordClass, '');
  assert.deepEqual(markers.labels.map((item) => item.label), ['Geografi']);
});

test('singkatan dua huruf yang terpisah tetap dikenali', () => {
  const markers = extractMarkers('<b>pang·kat</b> <em>k l n</em> <b>1</b> tingkat');
  assert.equal(markers.wordClass, 'n');
  assert.deepEqual(markers.labels.map((item) => item.label), ['Klasik']);
});

test('lafal dalam garis miring tercatat terpisah dari makna', () => {
  const entry = parse('<b>af·de·ling</b> /afdéling/ <em>Bld n</em> seksi; bagian; divisi');
  assert.equal(entry.pronunciation, 'afdéling');
  assert.equal(entry.wordClass, 'n');
  assert.equal(entry.senses[0].text, 'seksi; bagian; divisi');
});

test('makna pertama bersih dari kepala lema, lafal, dan label', () => {
  assert.equal(parse('<b>ca·ha·ya</b> <em>n</em> <b>1</b> sinar atau terang; <b>2</b> kilau').senses[0].text, 'sinar atau terang;');
  assert.equal(parse('<b>a·ben</b> /abén/, <b>meng·a·ben</b> <em>Bl v</em> membakar mayat;').senses[0].text, 'membakar mayat;');
  assert.equal(stripSenseHead('/abén/, meng·a·ben Bl v membakar mayat'), 'membakar mayat');
});

test('tanda -- pada bentuk turunan diganti lema induk', () => {
  const entry = parse('<b>acuh</b> <em>v</em> peduli;<br><b>acuh tak --</b> tidak peduli');
  assert.deepEqual(entry.derivatives.map((item) => item.word), ['acuh tak acuh']);
});

test('bentuk terikat dikenali sebagai label, bukan kelas kata', () => {
  const entry = parse('<b>-lah</b> <em>bentuk terikat</em> yang digunakan untuk menekankan');
  assert.equal(entry.wordClass, '');
  assert.deepEqual(entry.labels.map((item) => item.label), ['Bentuk terikat']);
  assert.equal(entry.senses[0].text, 'yang digunakan untuk menekankan');
});
