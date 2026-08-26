const state = {
  stats: null, q: '', letter: '', wordClass: '', label: '',
  offset: 0, limit: 18, selected: null, poster: null, listMode: false,
  showAllLabels: false, loading: false, lastFocus: null, suggestionIndex: -1,
  graphTypes: new Set(['sinonim', 'antonim', 'hierarki']), graphQuery: ''
};
const $ = (selector, scope = document) => scope.querySelector(selector);
const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];
const formatNumber = (value) => new Intl.NumberFormat('id-ID', { notation: value > 999999 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(value || 0);
const escapeHtml = (value = '') => String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
const className = (code) => ['n', 'v', 'a', 'adv'].includes(code) ? code : 'unknown';
// Pintasan papan ketik tidak boleh merebut fokus saat pengguna sedang mengetik,
// termasuk di kotak saring peta hubungan.
const isTyping = (element) => element instanceof HTMLElement
  && (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA' || element.isContentEditable);

async function api(path) {
  const response = await fetch(path);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Permintaan gagal');
  return data;
}

async function loadStats() {
  const stats = await api('/api/stats');
  state.stats = stats;
  $('#stat-entries').textContent = formatNumber(stats.lexemes || stats.entries);
  $('#stat-relations').textContent = formatNumber(stats.relationTotal);
  const coverage = Math.min(100, stats.coverage * 100);
  $('#stat-coverage').textContent = `${coverage.toFixed(1)}%`;
  $('#coverage-number').textContent = `${coverage.toFixed(1)}%`;
  $('#coverage-bar').style.width = `${coverage}%`;
  const pending = stats.queue.pending || 0;
  const errors = stats.queue.error || 0;
  $('#coverage-detail').textContent = `${formatNumber(stats.entries)} laman · ${formatNumber(stats.lexemes)} lema & bentuk turunan · ${formatNumber(pending)} menunggu${errors ? ` · ${formatNumber(errors)} gagal` : ''}`;
  $('#crawl-label').textContent = ({
    running: 'Scraper sedang berjalan',
    waiting: 'Scraper menunggu koneksi',
    paused: 'Scraper dijeda',
    error: 'Scraper perlu diperiksa',
    idle: pending ? 'Antrean siap dilanjutkan' : 'Basis data lokal siap'
  })[stats.crawl.state] || 'Basis data lokal siap';
  $('#synonym-count').textContent = formatNumber(stats.relations.sinonim || 0);
  $('#antonym-count').textContent = formatNumber(stats.relations.antonim || 0);
  renderFilters(stats);
}

// Panel penyaring dibangun ulang berkala. Fokus papan ketik dikembalikan supaya
// penyegaran latar tidak melempar pengguna keluar dari tombol yang sedang dipilih.
function withPreservedFocus(container, render) {
  const activeKey = container.contains(document.activeElement)
    ? document.activeElement.dataset.class ?? document.activeElement.dataset.letter ?? document.activeElement.dataset.label
    : null;
  render();
  if (activeKey === null || activeKey === undefined) return;
  const restored = container.querySelector(`[data-class="${CSS.escape(activeKey)}"], [data-letter="${CSS.escape(activeKey)}"], [data-label="${CSS.escape(activeKey)}"]`);
  restored?.focus();
}

function renderFilters(stats) {
  const allCount = stats.lexemes || stats.entries;
  withPreservedFocus($('#class-filters'), () => {
    $('#class-filters').innerHTML = [
      `<button class="class-filter ${state.wordClass ? '' : 'active'}" data-class=""><span>Semua kelas</span><small>${formatNumber(allCount)}</small></button>`,
      ...stats.byClass.map((item) => `<button class="class-filter ${state.wordClass === item.code ? 'active' : ''}" data-class="${escapeHtml(item.code)}"><span>${escapeHtml(item.label)}</span><small>${formatNumber(item.count)}</small></button>`)
    ].join('');
  });
  withPreservedFocus($('#letter-filters'), () => {
    const available = new Set(stats.byLetter.map((item) => item.letter));
    $('#letter-filters').innerHTML = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((letter) =>
      `<button class="letter-filter ${state.letter === letter ? 'active' : ''}" data-letter="${letter}" ${available.has(letter) ? '' : 'disabled'}>${letter}</button>`
    ).join('');
  });
  renderLabelFilters(stats);
}

function renderLabelFilters(stats) {
  const container = $('#label-filters');
  if (!container) return;
  const labels = stats.byLabel ?? [];
  const block = $('#label-filter-block');
  if (block) block.hidden = labels.length === 0;
  if (!labels.length) { container.innerHTML = ''; return; }
  const kinds = stats.labelKinds ?? {};
  const grouped = new Map();
  for (const item of labels) {
    if (!grouped.has(item.kind)) grouped.set(item.kind, []);
    grouped.get(item.kind).push(item);
  }
  const perKind = state.showAllLabels ? Infinity : 6;
  withPreservedFocus(container, () => {
    container.innerHTML = [
      `<button class="label-filter reset ${state.label ? '' : 'active'}" data-label="">Semua label</button>`,
      ...[...grouped].map(([kind, items]) => `
        <div class="label-group"><b>${escapeHtml(kinds[kind] ?? kind)}</b>${items.slice(0, perKind).map((item) =>
          `<button class="label-filter ${state.label === item.code ? 'active' : ''}" data-label="${escapeHtml(item.code)}" title="${escapeHtml(item.label)} · ${formatNumber(item.count)} entri"><span>${escapeHtml(item.label)}</span><small>${formatNumber(item.count)}</small></button>`
        ).join('')}</div>`)
    ].join('');
  });
  const total = labels.length;
  const shown = [...grouped.values()].reduce((sum, items) => sum + Math.min(items.length, perKind), 0);
  $('#label-toggle').hidden = total <= shown && !state.showAllLabels;
  $('#label-toggle').textContent = state.showAllLabels ? 'Tampilkan lebih sedikit' : `Tampilkan semua (${formatNumber(total)})`;
}

function loadingCards() {
  $('#word-grid').innerHTML = Array.from({ length: 6 }, () => '<div class="skeleton"></div>').join('');
}

async function loadWords({ append = false } = {}) {
  if (state.loading) return;
  state.loading = true;
  $('#load-more').disabled = true;
  if (!append) { state.offset = 0; loadingCards(); }
  const params = new URLSearchParams({ limit: state.limit, offset: state.offset });
  if (state.q) params.set('q', state.q);
  if (state.letter) params.set('letter', state.letter);
  if (state.wordClass) params.set('class', state.wordClass);
  if (state.label) params.set('label', state.label);
  try {
    const result = await api(`/api/words?${params}`);
    renderWords(result, append);
    state.offset += result.items.length;
  } catch (error) {
    $('#word-grid').innerHTML = `<div class="empty-state"><div><strong>Belum dapat memuat data</strong>${escapeHtml(error.message)}</div></div>`;
  } finally {
    state.loading = false;
    $('#load-more').disabled = false;
  }
}

function activeContexts() {
  const contexts = [];
  if (state.q) contexts.push(`untuk “${state.q}”`);
  if (state.letter) contexts.push(`berawalan ${state.letter}`);
  if (state.wordClass) {
    const match = state.stats?.byClass.find((item) => item.code === state.wordClass);
    contexts.push(match?.label ?? state.wordClass);
  }
  if (state.label) {
    const match = state.stats?.byLabel?.find((item) => item.code === state.label);
    contexts.push(`berlabel ${match?.label ?? state.label}`);
  }
  return contexts;
}

function renderWords(result, append) {
  $('#result-count').textContent = formatNumber(result.total);
  const contexts = activeContexts();
  $('#result-context').textContent = contexts.length ? contexts.join(' · ') : 'dalam koleksi lokal';
  if (!result.items.length && !append) {
    $('#word-grid').innerHTML = '<div class="empty-state"><div><strong>Tidak ada kata ditemukan</strong>Coba ejaan atau filter yang berbeda.</div></div>';
  } else {
    const cards = result.items.map((item) => `
      <button class="word-card" data-slug="${escapeHtml(item.slug)}">
        <span class="word-meta"><span class="pos ${className(item.wordClass)}">${escapeHtml(item.kind === 'turunan' ? 'Bentuk turunan' : item.wordClassLabel || 'Entri')}</span><span>${escapeHtml(item.syllables || '')}</span></span>
        <h3>${escapeHtml(item.displayWord)}</h3>
        ${item.labels?.length ? `<span class="card-labels">${item.labels.slice(0, 3).map((label) => `<i class="tag ${escapeHtml(label.kind)}">${escapeHtml(label.label)}</i>`).join('')}</span>` : ''}
        <p>${escapeHtml(item.summary || 'Buka entri untuk melihat definisi lengkap.')}</p>
        <span class="arrow">↗</span>
      </button>`).join('');
    if (append) $('#word-grid').insertAdjacentHTML('beforeend', cards);
    else $('#word-grid').innerHTML = cards;
  }
  $('#load-more').hidden = !result.hasMore;
}

function syncUrl(slug) {
  const url = new URL(window.location.href);
  if (slug) url.searchParams.set('kata', slug);
  else url.searchParams.delete('kata');
  const next = `${url.pathname}${url.search}`;
  if (next !== `${window.location.pathname}${window.location.search}`) {
    window.history.pushState({ slug: slug ?? null }, '', next);
  }
}

async function openEntry(slug, { push = true } = {}) {
  const modal = $('#entry-modal');
  if (!modal.classList.contains('open')) state.lastFocus = document.activeElement;
  modal.classList.add('open');
  modal.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
  $('#entry-content').innerHTML = '<div class="entry-loading">Membuka lembar kata…</div>';
  $('.entry-sheet').focus();
  if (push) syncUrl(slug);
  try {
    const entry = await api(`/api/words/${encodeURIComponent(slug)}`);
    state.selected = entry;
    renderEntry(entry);
    renderGraph(entry);
  } catch (error) {
    $('#entry-content').innerHTML = `<div class="entry-loading">${escapeHtml(error.message)}</div>`;
  }
}

const RELATION_ORDER = ['sinonim', 'antonim', 'hipernim', 'hiponim', 'meronim', 'holonim', 'rujukan', 'dirujuk oleh'];

function pillTitle(item) {
  const notes = [item.sourceLabel];
  if (item.via) notes.push(`lewat bentuk turunan ${item.via}`);
  if (item.hostWord) notes.push(`tercatat pada entri ${item.hostWord}`);
  return notes.join(' · ');
}

function relationPills(items, type) {
  return `<div class="pills">${items.map((item) =>
    `<button class="pill ${type === 'antonim' ? 'antonim' : ''} ${item.slug ? 'clickable' : ''}" ${item.slug ? `data-slug="${escapeHtml(item.slug)}"` : 'disabled'} title="${escapeHtml(pillTitle(item))}">${escapeHtml(item.word)}</button>`
  ).join('')}</div>`;
}

function directRelationHtml(groups) {
  const types = [...RELATION_ORDER, ...Object.keys(groups).filter((type) => !RELATION_ORDER.includes(type))];
  return types.filter((type) => groups[type]?.length).map((type) => {
    const items = groups[type].slice(0, 28);
    return `<div class="relation-group"><span>${escapeHtml(type)} · ${items.length}</span>${relationPills(items, type)}</div>`;
  }).join('');
}

// Relasi turunan dikelompokkan menurut bentuk asalnya, bukan hanya menurut jenis,
// supaya jelas bahwa "kesegaran" datang dari "kebugaran" dan bukan sinonim
// langsung dari lema induknya.
function derivedRelationHtml(items) {
  if (!items?.length) return '';
  const buckets = new Map();
  for (const item of items) {
    const key = `${item.via}␟${item.type}`;
    if (!buckets.has(key)) buckets.set(key, { via: item.via, type: item.type, items: [] });
    buckets.get(key).items.push(item);
  }
  const blocks = [...buckets.values()]
    .sort((a, b) => b.items.length - a.items.length)
    .slice(0, 8)
    .map((bucket) => `<div class="relation-group derived"><span>lewat <b>${escapeHtml(bucket.via)}</b> · ${escapeHtml(bucket.type)} · ${bucket.items.length}</span>${relationPills(bucket.items.slice(0, 20), bucket.type)}</div>`)
    .join('');
  return `<section class="entry-section"><h3>Relasi lewat bentuk turunan</h3>${blocks}<p class="data-note">Lema ini tidak dikenal WordNet Bahasa, jadi yang ditampilkan adalah relasi milik bentuk turunannya. Kaitannya lebih longgar daripada relasi langsung dan perlu diperiksa sesuai konteks.</p><button class="graph-jump" type="button" data-view-graph>Lihat peta hubungan kata ↓</button></section>`;
}

function renderEntry(entry) {
  const groups = entry.relationGroups ?? {};
  const relationHtml = directRelationHtml(groups);
  const derivedHtml = relationHtml ? '' : derivedRelationHtml(entry.derivedRelations);
  const senses = entry.senses.length ? entry.senses.slice(0, 12).map((sense) => `
    <div class="sense"><span class="sense-no">${sense.number}</span><span>${escapeHtml(sense.text)}</span></div>`).join('') : '<p>Definisi terstruktur belum tersedia.</p>';
  const derivatives = entry.derivatives.slice(0, 24).map((item) => `
    <div class="derivative"><b>${escapeHtml(item.word)}</b><span>${escapeHtml(item.meaning)}</span></div>`).join('');
  const labels = (entry.labels ?? []).map((label) =>
    `<button class="tag ${escapeHtml(label.kind)} clickable" data-label-filter="${escapeHtml(label.code)}" title="Saring entri berlabel ${escapeHtml(label.label)}">${escapeHtml(label.label)}</button>`).join('');
  $('#entry-content').innerHTML = `
    <div class="entry-kicker"><span class="pos ${className(entry.wordClass)}">${escapeHtml(entry.wordClassLabel || 'Entri')}</span><span>Arsip KBBI</span></div>
    <h2 class="entry-title" id="entry-title">${escapeHtml(entry.displayWord)}</h2>
    <p class="entry-syllables">${escapeHtml(entry.syllables || entry.word)}${entry.pronunciation ? ` <span class="entry-pron">/${escapeHtml(entry.pronunciation)}/</span>` : ''}</p>
    ${labels ? `<div class="entry-tags">${labels}</div>` : ''}
    <section class="entry-section"><h3>Makna</h3>${senses}</section>
    ${relationHtml ? `<section class="entry-section"><h3>Relasi semantik</h3>${relationHtml}<p class="data-note">Relasi WordNet dipetakan pada tingkat synset dan dapat mencakup makna yang berbeda. Periksa konteks sebelum digunakan.</p><button class="graph-jump" type="button" data-view-graph>Lihat peta hubungan kata ↓</button></section>` : derivedHtml}
    ${derivatives ? `<section class="entry-section"><h3>Bentuk turunan & gabungan</h3><div class="derivative-list">${derivatives}</div></section>` : ''}
    <section class="entry-section"><h3>Naskah sumber lengkap</h3><div class="source-definition">${entry.definitionHtml}</div></section>
    <section class="entry-section"><div class="entry-actions"><a class="source-link" href="${escapeHtml(entry.sourceUrl)}" target="_blank" rel="noreferrer">Lihat halaman sumber di KBBI.web.id <span>↗</span></a><button class="copy-link" type="button" data-copy-link>Salin tautan entri</button></div><p class="data-note">Diambil ${new Date(entry.scrapedAt).toLocaleString('id-ID')}. Basis utama situs sumber mengacu pada KBBI Edisi III dan merupakan hak cipta Badan Bahasa.</p></section>`;
}

// Peta hanya sanggup memuat sekitar enam belas simpul sebelum labelnya bertindih.
// Jatah dibagi menurut bobot tiap kategori, lalu dihitung ulang ketika sebagian
// kategori dimatikan supaya ruang yang kosong terpakai oleh kategori yang tersisa.
const GRAPH_GROUPS = [
  { key: 'sinonim', label: 'sinonim', types: ['sinonim'], weight: 7 },
  { key: 'antonim', label: 'antonim', types: ['antonim'], weight: 4 },
  { key: 'hierarki', label: 'hierarki', types: ['hipernim', 'hiponim'], weight: 5 }
];
const GRAPH_BUDGET = 16;
const nodeKind = (type) => (type === 'sinonim' || type === 'antonim' ? type : 'other');

function takeInterleaved(lists, count) {
  const taken = [];
  for (let depth = 0; taken.length < count && lists.some((list) => depth < list.length); depth += 1) {
    for (const list of lists) {
      if (depth < list.length && taken.length < count) taken.push(list[depth]);
    }
  }
  return taken;
}

// Bila lema induk tidak dikenal WordNet, peta memakai relasi bentuk turunannya
// dan menandainya dengan garis putus-putus serta keterangan di bawah legenda.
const graphRelations = (entry) => (entry.relations?.length ? entry.relations : entry.derivedRelations ?? []);

function collectGraphGroups(entry) {
  const needle = state.graphQuery.trim().toLocaleLowerCase('id');
  const matches = (item) => !needle || item.word.toLocaleLowerCase('id').includes(needle);
  const source = graphRelations(entry);
  const groups = GRAPH_GROUPS.map((group) => {
    const pool = source.filter((item) => group.types.includes(item.type));
    return {
      ...group,
      enabled: state.graphTypes.has(group.key),
      total: pool.length,
      matched: pool.filter(matches).length,
      lists: group.types.map((type) => pool.filter((item) => item.type === type && matches(item)))
    };
  });
  allocateGraphQuota(groups);
  for (const group of groups) group.visible = takeInterleaved(group.lists, group.quota);
  return groups;
}

// Jatah dibagi menurut bobot, lalu diputar lagi: kategori yang kecocokannya lebih
// sedikit daripada jatahnya menyerahkan sisanya kepada kategori yang masih punya
// calon. Tanpa itu, menyaring teks akan menyisakan ruang kosong di peta.
function allocateGraphQuota(groups) {
  for (const group of groups) group.quota = 0;
  let pool = groups.filter((group) => group.enabled && group.matched > 0);
  let budget = GRAPH_BUDGET;
  while (budget > 0 && pool.length) {
    const weightSum = pool.reduce((sum, group) => sum + group.weight, 0);
    let handed = 0;
    for (const group of pool) {
      const want = Math.max(1, Math.round(budget * group.weight / weightSum));
      const take = Math.min(want, group.matched - group.quota, budget - handed);
      group.quota += take;
      handed += take;
    }
    if (!handed) break;
    budget -= handed;
    pool = pool.filter((group) => group.quota < group.matched);
  }
}

function graphEmptyMessage(entry, groups) {
  const word = entry.displayWord || entry.word;
  if (!groups.some((group) => group.enabled)) return 'Semua kategori dimatikan. Nyalakan salah satu legenda untuk menggambar jejaring.';
  // Kekosongan di sini hampir selalu batas sumber data, bukan kegagalan sistem:
  // jejaring berasal dari WordNet Bahasa yang kosakatanya jauh lebih sempit
  // daripada KBBI, sementara halaman KBBI sendiri jarang menyebut sinonim.
  if (!groups.some((group) => group.total)) {
    return `“${word}” belum ada di WordNet Bahasa dan halaman sumbernya tidak menyebut sinonim, antonim, atau rujukan. Sekitar dua pertiga entri KBBI berada di luar jangkauan WordNet.`;
  }
  if (state.graphQuery.trim()) return `Tidak ada simpul yang memuat “${state.graphQuery.trim()}” pada kategori terpilih.`;
  return `Kategori terpilih tidak memiliki relasi untuk “${word}”.`;
}

function renderGraph(entry) {
  const svg = $('#relation-graph');
  svg.replaceChildren();
  $('#graph-word').textContent = entry.displayWord || entry.word;
  const groups = collectGraphGroups(entry);
  for (const group of groups) updateGraphLegend(group);
  $('#graph-reset').hidden = !state.graphQuery && state.graphTypes.size === GRAPH_GROUPS.length;
  const derivedMode = !entry.relations?.length && Boolean(entry.derivedRelations?.length);
  const note = $('#graph-note');
  note.hidden = !derivedMode;
  if (derivedMode) {
    const sumber = [...new Set(entry.derivedRelations.map((item) => item.via))].slice(0, 3);
    note.textContent = `“${entry.displayWord || entry.word}” belum ada di WordNet Bahasa. Yang digambar adalah relasi bentuk turunannya (${sumber.join(', ')}), jadi kaitannya lebih longgar.`;
  }
  const visible = groups.flatMap((group) => group.visible).slice(0, GRAPH_BUDGET);
  $('#graph-empty').textContent = visible.length ? '' : graphEmptyMessage(entry, groups);
  $('#graph-empty').hidden = visible.length > 0;
  if (!visible.length) return;
  const ns = 'http://www.w3.org/2000/svg';
  const cx = 380, cy = 238;
  const radiusX = visible.length < 7 ? 245 : 295;
  const radiusY = visible.length < 7 ? 160 : 190;
  visible.forEach((item, index) => {
    const angle = (Math.PI * 2 * index / visible.length) - Math.PI / 2;
    const x = cx + Math.cos(angle) * radiusX;
    const y = cy + Math.sin(angle) * radiusY;
    const line = document.createElementNS(ns, 'line');
    line.setAttribute('x1', cx); line.setAttribute('y1', cy); line.setAttribute('x2', x); line.setAttribute('y2', y);
    line.setAttribute('class', `graph-line ${nodeKind(item.type)}${item.derived ? ' derived' : ''}`);
    svg.append(line);
    addGraphNode(svg, { x, y, label: item.word, kind: nodeKind(item.type), slug: item.slug, radius: 31, type: item.derived ? `${item.type} lewat ${item.via}` : item.type, derived: item.derived });
  });
  addGraphNode(svg, { x: cx, y: cy, label: entry.word, kind: 'center', slug: entry.slug, radius: 55 });
}

function refreshGraph() {
  if (state.selected) renderGraph(state.selected);
}

let graphFilterTimer;

function resetGraphFilters() {
  clearTimeout(graphFilterTimer);
  state.graphQuery = '';
  state.graphTypes = new Set(GRAPH_GROUPS.map((group) => group.key));
  $('#graph-filter').value = '';
  refreshGraph();
}

function updateGraphLegend({ key, label, enabled, visible, matched, total }) {
  const item = $(`#legend-${key}`);
  const count = $(`#legend-${key}-count`);
  count.textContent = String(visible.length);
  item.setAttribute('aria-pressed', String(enabled));
  item.classList.toggle('off', !enabled);
  item.classList.toggle('empty', total === 0);
  if (total === 0) item.title = `Tidak ada ${label} untuk kata terpilih`;
  else if (!enabled) item.title = `${total} hubungan ${label} disembunyikan; klik untuk menampilkan`;
  else if (state.graphQuery.trim()) item.title = `${visible.length} dari ${matched} ${label} yang cocok (total ${total}); klik untuk menyembunyikan`;
  else item.title = `${visible.length} dari ${total} hubungan ${label} ditampilkan; klik untuk menyembunyikan`;
}

function splitGraphLabel(label, maxChars = 11) {
  const value = String(label || '').trim();
  if (value.length <= maxChars) return [value];
  const words = value.split(/\s+/).filter(Boolean);
  if (words.length === 1) {
    const middle = Math.ceil(value.length / 2);
    return [value.slice(0, middle), value.slice(middle)];
  }
  const lines = [];
  let current = '';
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length <= maxChars) current = next;
    else {
      if (current) lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  if (lines.length <= 2) return lines;
  return [lines[0], `${lines.slice(1).join(' ').slice(0, maxChars - 1)}…`];
}

function addGraphNode(svg, { x, y, label, kind, slug, radius, type, derived }) {
  const ns = 'http://www.w3.org/2000/svg';
  const group = document.createElementNS(ns, 'g');
  group.setAttribute('class', `graph-node ${kind}${derived ? ' derived' : ''}`);
  group.setAttribute('transform', `translate(${x} ${y})`);
  group.setAttribute('tabindex', '0');
  group.setAttribute('role', 'button');
  group.setAttribute('aria-label', type ? `${label} — ${type}` : label);
  const circle = document.createElementNS(ns, 'circle');
  circle.setAttribute('r', radius);
  const text = document.createElementNS(ns, 'text');
  const lines = splitGraphLabel(label, kind === 'center' ? 15 : 11);
  text.style.fontSize = kind === 'center' ? (label.length > 14 ? '14px' : '18px') : (label.length > 10 ? '9px' : '10px');
  lines.forEach((line, index) => {
    const tspan = document.createElementNS(ns, 'tspan');
    tspan.textContent = line;
    tspan.setAttribute('x', '0');
    tspan.setAttribute('dy', index === 0 ? (lines.length === 1 ? '.35em' : '-.15em') : '1.12em');
    text.append(tspan);
  });
  const title = document.createElementNS(ns, 'title');
  title.textContent = type ? `${label} — ${type}` : label;
  group.append(circle, text, title);
  if (slug) {
    group.addEventListener('click', () => openEntry(slug));
    group.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openEntry(slug); }
    });
  }
  svg.append(group);
}

function closeModal({ push = true } = {}) {
  const modal = $('#entry-modal');
  if (!modal.classList.contains('open')) return;
  modal.classList.remove('open');
  modal.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
  if (push) syncUrl(null);
  state.lastFocus?.focus?.();
  state.lastFocus = null;
}

// Selama lembar kata terbuka, Tab tetap berputar di dalamnya supaya pembaca
// layar dan pengguna papan ketik tidak tersesat ke halaman di belakangnya.
function trapFocus(event) {
  if (event.key !== 'Tab' || !$('#entry-modal').classList.contains('open')) return;
  const sheet = $('.entry-sheet');
  const focusable = $$('a[href], button:not([disabled]), input, [tabindex]:not([tabindex="-1"])', sheet)
    .filter((element) => element.offsetParent !== null || element === document.activeElement);
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && (document.activeElement === first || document.activeElement === sheet)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

async function loadPoster() {
  try {
    const entry = await api('/api/random');
    state.poster = entry;
    $('#poster-word').textContent = entry.word;
    $('#poster-syllables').textContent = entry.pronunciation ? `/${entry.pronunciation}/` : (entry.syllables || entry.word);
    $('#poster-class').textContent = (entry.wordClassLabel || 'ENTRI').toUpperCase();
    $('#poster-index').textContent = `dari ${formatNumber(state.stats?.entries || 0)} entri`;
  } catch { /* Basis data kosong ditangani oleh daftar utama. */ }
}

async function loadFeaturedGraph() {
  const requested = new URLSearchParams(window.location.search).get('kata');
  for (const slug of [...new Set([requested, 'baik', 'hidup', 'gerak'].filter(Boolean))]) {
    try {
      const entry = await api(`/api/words/${encodeURIComponent(slug)}`);
      if (entry.relations?.length) {
        state.selected = entry;
        renderGraph(entry);
        return;
      }
    } catch { /* Coba contoh berikutnya bila entri belum tersedia. */ }
  }
  $('#graph-word').textContent = 'Belum tersedia';
}

let suggestionTimer;

function hideSuggestions() {
  $('#search-suggestions').hidden = true;
  state.suggestionIndex = -1;
}

async function updateSuggestions() {
  const q = $('#search-input').value.trim();
  const container = $('#search-suggestions');
  if (q.length < 2) { hideSuggestions(); return; }
  try {
    const result = await api(`/api/words?q=${encodeURIComponent(q)}&limit=6`);
    if (!result.items.length) { hideSuggestions(); return; }
    container.innerHTML = result.items.map((item) => `<button type="button" class="suggestion" data-slug="${escapeHtml(item.slug)}"><b>${escapeHtml(item.displayWord)}</b><small>${escapeHtml(item.kind === 'turunan' ? 'Bentuk turunan' : item.wordClassLabel || '')}</small></button>`).join('');
    container.hidden = false;
    state.suggestionIndex = -1;
  } catch { hideSuggestions(); }
}

function moveSuggestion(step) {
  const options = $$('.suggestion');
  if (!options.length) return;
  state.suggestionIndex = (state.suggestionIndex + step + options.length) % options.length;
  options.forEach((option, index) => option.classList.toggle('highlight', index === state.suggestionIndex));
  options[state.suggestionIndex].scrollIntoView({ block: 'nearest' });
}

function applyFilter(changes) {
  Object.assign(state, changes);
  if (state.stats) renderFilters(state.stats);
  loadWords();
}

// Menu atas mengikuti bagian yang sedang dibaca, bukan hanya klik terakhir.
// Perbandingan posisi dipakai alih-alih IntersectionObserver karena hanya ada
// tiga bagian dan hitungannya murah, sekaligus tetap jalan pada peramban yang
// menunda callback pengamat saat halaman tidak digambar.
function watchSections() {
  const links = $$('.nav-link');
  const sections = links
    .map((link) => ({ link, element: $(`#${link.dataset.section}`) }))
    .filter((item) => item.element);
  if (!sections.length) return;
  let lastRun = 0;
  const update = () => {
    const middle = window.innerHeight * 0.42;
    let current = sections[0];
    for (const section of sections) {
      if (section.element.getBoundingClientRect().top <= middle) current = section;
    }
    for (const section of sections) section.link.classList.toggle('active', section === current);
  };
  window.addEventListener('scroll', () => {
    const now = Date.now();
    if (now - lastRun < 100) return;
    lastRun = now;
    update();
  }, { passive: true });
  window.addEventListener('resize', update, { passive: true });
  update();
}

function bindEvents() {
  $('#search-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    state.q = $('#search-input').value.trim();
    hideSuggestions();
    await loadWords();
    $('#jelajah').scrollIntoView({ behavior: 'smooth' });
  });
  $('#search-input').addEventListener('input', () => { clearTimeout(suggestionTimer); suggestionTimer = setTimeout(updateSuggestions, 180); });
  $('#search-input').addEventListener('keydown', (event) => {
    if ($('#search-suggestions').hidden) return;
    if (event.key === 'ArrowDown') { event.preventDefault(); moveSuggestion(1); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); moveSuggestion(-1); }
    else if (event.key === 'Escape') { event.preventDefault(); hideSuggestions(); }
    else if (event.key === 'Enter' && state.suggestionIndex >= 0) {
      event.preventDefault();
      const option = $$('.suggestion')[state.suggestionIndex];
      hideSuggestions();
      if (option) openEntry(option.dataset.slug);
    }
  });
  $('#search-suggestions').addEventListener('click', (event) => {
    const button = event.target.closest('[data-slug]');
    if (button) { hideSuggestions(); openEntry(button.dataset.slug); }
  });
  document.addEventListener('pointerdown', (event) => {
    if (!$('#search-form').contains(event.target)) hideSuggestions();
  });
  $('.quick-links').addEventListener('click', (event) => {
    const button = event.target.closest('[data-query]');
    if (!button) return;
    $('#search-input').value = button.dataset.query;
    state.q = button.dataset.query;
    loadWords();
    $('#jelajah').scrollIntoView({ behavior: 'smooth' });
  });
  $('#word-grid').addEventListener('click', (event) => { const card = event.target.closest('[data-slug]'); if (card) openEntry(card.dataset.slug); });
  $('#entry-content').addEventListener('click', async (event) => {
    if (event.target.closest('[data-view-graph]')) {
      closeModal();
      $('#relasi').scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    const labelButton = event.target.closest('[data-label-filter]');
    if (labelButton) {
      closeModal();
      applyFilter({ label: labelButton.dataset.labelFilter });
      $('#jelajah').scrollIntoView({ behavior: 'smooth' });
      return;
    }
    const copyButton = event.target.closest('[data-copy-link]');
    if (copyButton) {
      try {
        await navigator.clipboard.writeText(window.location.href);
        copyButton.textContent = 'Tautan disalin';
      } catch {
        copyButton.textContent = 'Salin manual dari bilah alamat';
      }
      setTimeout(() => { copyButton.textContent = 'Salin tautan entri'; }, 2200);
      return;
    }
    const button = event.target.closest('[data-slug]');
    if (button && !button.disabled) openEntry(button.dataset.slug);
  });
  $$('[data-close-modal]').forEach((button) => button.addEventListener('click', () => closeModal()));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && $('#entry-modal').classList.contains('open')) closeModal();
    trapFocus(event);
    if (event.key === '/' && !isTyping(document.activeElement) && !$('#entry-modal').classList.contains('open')) {
      event.preventDefault();
      $('#search-input').focus();
    }
  });
  $('#class-filters').addEventListener('click', (event) => {
    const button = event.target.closest('[data-class]');
    if (button) applyFilter({ wordClass: button.dataset.class });
  });
  $('#letter-filters').addEventListener('click', (event) => {
    const button = event.target.closest('[data-letter]');
    if (button && !button.disabled) applyFilter({ letter: state.letter === button.dataset.letter ? '' : button.dataset.letter });
  });
  $('#label-filters').addEventListener('click', (event) => {
    const button = event.target.closest('[data-label]');
    if (button) applyFilter({ label: state.label === button.dataset.label ? '' : button.dataset.label });
  });
  $('#label-toggle').addEventListener('click', () => {
    state.showAllLabels = !state.showAllLabels;
    if (state.stats) renderLabelFilters(state.stats);
  });
  $('#reset-filter').addEventListener('click', () => {
    $('#search-input').value = '';
    applyFilter({ q: '', letter: '', wordClass: '', label: '' });
  });
  $('#load-more').addEventListener('click', () => loadWords({ append: true }));
  $$('.view-toggle button').forEach((button, index) => button.addEventListener('click', () => {
    state.listMode = index === 1;
    $$('.view-toggle button').forEach((item, position) => item.classList.toggle('active', position === index));
    $('#word-grid').classList.toggle('list', state.listMode);
  }));
  $$('.nav-link').forEach((button) => button.addEventListener('click', () => {
    $$('.nav-link').forEach((item) => item.classList.toggle('active', item === button));
    $(`#${button.dataset.section}`).scrollIntoView({ behavior: 'smooth' });
  }));
  $('.graph-toolbar').addEventListener('click', (event) => {
    const legend = event.target.closest('[data-graph-type]');
    if (!legend) return;
    const key = legend.dataset.graphType;
    if (state.graphTypes.has(key)) state.graphTypes.delete(key);
    else state.graphTypes.add(key);
    refreshGraph();
  });
  $('#graph-filter').addEventListener('input', () => {
    clearTimeout(graphFilterTimer);
    graphFilterTimer = setTimeout(() => { state.graphQuery = $('#graph-filter').value; refreshGraph(); }, 140);
  });
  $('#graph-filter').addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !$('#graph-filter').value) return;
    event.stopPropagation();
    resetGraphFilters();
  });
  $('#graph-reset').addEventListener('click', () => { resetGraphFilters(); $('#graph-filter').focus(); });
  $('#random-word').addEventListener('click', async () => {
    try {
      const entry = await api('/api/random');
      openEntry(entry.slug);
    } catch (error) {
      $('#crawl-label').textContent = error.message;
    }
  });
  $('#open-poster').addEventListener('click', () => state.poster && openEntry(state.poster.slug));
  // Tombol kembali menutup lembar kata, lalu membukanya lagi saat maju.
  window.addEventListener('popstate', () => {
    const slug = new URLSearchParams(window.location.search).get('kata');
    if (slug) openEntry(slug, { push: false });
    else closeModal({ push: false });
  });
}

async function init() {
  bindEvents();
  watchSections();
  try { await loadStats(); } catch (error) { console.error(error); }
  await Promise.all([loadWords(), loadPoster(), loadFeaturedGraph()]);
  const requested = new URLSearchParams(window.location.search).get('kata');
  if (requested) openEntry(requested, { push: false });
  setInterval(() => loadStats().catch((error) => console.error(error)), 30_000);
}

init();
