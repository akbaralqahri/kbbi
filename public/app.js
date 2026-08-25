const state = { stats: null, q: '', letter: '', wordClass: '', offset: 0, limit: 18, selected: null, poster: null, listMode: false };
const $ = (selector, scope = document) => scope.querySelector(selector);
const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];
const formatNumber = (value) => new Intl.NumberFormat('id-ID', { notation: value > 999999 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(value || 0);
const escapeHtml = (value = '') => String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
const className = (code) => ['n', 'v', 'a', 'adv'].includes(code) ? code : 'unknown';

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
    error: 'Scraper perlu diperiksa',
    idle: pending ? 'Antrean siap dilanjutkan' : 'Basis data lokal siap'
  })[stats.crawl.state] || 'Basis data lokal siap';
  $('#synonym-count').textContent = formatNumber(stats.relations.sinonim || 0);
  $('#antonym-count').textContent = formatNumber(stats.relations.antonim || 0);
  renderFilters(stats);
}

function renderFilters(stats) {
  const allCount = stats.lexemes || stats.entries;
  $('#class-filters').innerHTML = [
    `<button class="class-filter ${state.wordClass ? '' : 'active'}" data-class=""><span>Semua kelas</span><small>${formatNumber(allCount)}</small></button>`,
    ...stats.byClass.map((item) => `<button class="class-filter ${state.wordClass === item.code ? 'active' : ''}" data-class="${escapeHtml(item.code)}"><span>${escapeHtml(item.label)}</span><small>${formatNumber(item.count)}</small></button>`)
  ].join('');
  const available = new Set(stats.byLetter.map((item) => item.letter));
  $('#letter-filters').innerHTML = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((letter) =>
    `<button class="letter-filter ${state.letter === letter ? 'active' : ''}" data-letter="${letter}" ${available.has(letter) ? '' : 'disabled'}>${letter}</button>`
  ).join('');
}

function loadingCards() {
  $('#word-grid').innerHTML = Array.from({ length: 6 }, () => '<div class="skeleton"></div>').join('');
}

async function loadWords({ append = false } = {}) {
  if (!append) { state.offset = 0; loadingCards(); }
  const params = new URLSearchParams({ limit: state.limit, offset: state.offset });
  if (state.q) params.set('q', state.q);
  if (state.letter) params.set('letter', state.letter);
  if (state.wordClass) params.set('class', state.wordClass);
  try {
    const result = await api(`/api/words?${params}`);
    renderWords(result, append);
    state.offset += result.items.length;
  } catch (error) {
    $('#word-grid').innerHTML = `<div class="empty-state"><div><strong>Belum dapat memuat data</strong>${escapeHtml(error.message)}</div></div>`;
  }
}

function renderWords(result, append) {
  $('#result-count').textContent = formatNumber(result.total);
  const contexts = [];
  if (state.q) contexts.push(`untuk “${state.q}”`);
  if (state.letter) contexts.push(`berawalan ${state.letter}`);
  if (state.wordClass) contexts.push($(`[data-class="${CSS.escape(state.wordClass)}"]`)?.textContent.replace(/\d+/g, '').trim() || state.wordClass);
  $('#result-context').textContent = contexts.length ? contexts.join(' · ') : 'dalam koleksi lokal';
  if (!result.items.length && !append) {
    $('#word-grid').innerHTML = `<div class="empty-state"><div><strong>Tidak ada kata ditemukan</strong>Coba ejaan atau filter yang berbeda.</div></div>`;
  } else {
    const cards = result.items.map((item) => `
      <button class="word-card" data-slug="${escapeHtml(item.slug)}">
        <span class="word-meta"><span class="pos ${className(item.wordClass)}">${escapeHtml(item.kind === 'turunan' ? 'Bentuk turunan' : item.wordClassLabel || 'Entri')}</span><span>${escapeHtml(item.syllables || '')}</span></span>
        <h3>${escapeHtml(item.displayWord)}</h3>
        <p>${escapeHtml(item.summary || 'Buka entri untuk melihat definisi lengkap.')}</p>
        <span class="arrow">↗</span>
      </button>`).join('');
    if (append) $('#word-grid').insertAdjacentHTML('beforeend', cards);
    else $('#word-grid').innerHTML = cards;
  }
  $('#load-more').hidden = !result.hasMore;
}

async function openEntry(slug) {
  const modal = $('#entry-modal');
  modal.classList.add('open');
  modal.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
  $('#entry-content').innerHTML = '<div class="entry-loading">Membuka lembar kata…</div>';
  try {
    const entry = await api(`/api/words/${encodeURIComponent(slug)}`);
    state.selected = entry;
    renderEntry(entry);
    renderGraph(entry);
  } catch (error) {
    $('#entry-content').innerHTML = `<div class="entry-loading">${escapeHtml(error.message)}</div>`;
  }
}

function renderEntry(entry) {
  const orderedTypes = ['sinonim', 'antonim', 'hipernim', 'hiponim', 'meronim', 'holonim', 'rujukan'];
  const relationHtml = orderedTypes.filter((type) => entry.relationGroups[type]?.length).map((type) => {
    const items = entry.relationGroups[type].slice(0, 28);
    return `<div class="relation-group"><span>${escapeHtml(type)} · ${items.length}</span><div class="pills">${items.map((item) =>
      `<button class="pill ${type === 'antonim' ? 'antonim' : ''} ${item.slug ? 'clickable' : ''}" ${item.slug ? `data-slug="${escapeHtml(item.slug)}"` : 'disabled'} title="${escapeHtml(item.sourceLabel)}">${escapeHtml(item.word)}</button>`
    ).join('')}</div></div>`;
  }).join('');
  const senses = entry.senses.length ? entry.senses.slice(0, 12).map((sense) => `
    <div class="sense"><span class="sense-no">${sense.number}</span><span>${escapeHtml(sense.text)}</span></div>`).join('') : '<p>Definisi terstruktur belum tersedia.</p>';
  const derivatives = entry.derivatives.slice(0, 24).map((item) => `
    <div class="derivative"><b>${escapeHtml(item.word)}</b><span>${escapeHtml(item.meaning)}</span></div>`).join('');
  $('#entry-content').innerHTML = `
    <div class="entry-kicker"><span class="pos ${className(entry.wordClass)}">${escapeHtml(entry.wordClassLabel || 'Entri')}</span><span>Arsip KBBI</span></div>
    <h2 class="entry-title" id="entry-title">${escapeHtml(entry.displayWord)}</h2>
    <p class="entry-syllables">${escapeHtml(entry.syllables || entry.word)}</p>
    <section class="entry-section"><h3>Makna</h3>${senses}</section>
    ${relationHtml ? `<section class="entry-section"><h3>Relasi semantik</h3>${relationHtml}<p class="data-note">Relasi WordNet dipetakan pada tingkat synset dan dapat mencakup makna yang berbeda. Periksa konteks sebelum digunakan.</p><button class="graph-jump" type="button" data-view-graph>Lihat peta hubungan kata ↓</button></section>` : ''}
    ${derivatives ? `<section class="entry-section"><h3>Bentuk turunan & gabungan</h3><div class="derivative-list">${derivatives}</div></section>` : ''}
    <section class="entry-section"><h3>Naskah sumber lengkap</h3><div class="source-definition">${entry.definitionHtml}</div></section>
    <section class="entry-section"><a class="source-link" href="${escapeHtml(entry.sourceUrl)}" target="_blank" rel="noreferrer">Lihat halaman sumber di KBBI.web.id <span>↗</span></a><p class="data-note">Diambil ${new Date(entry.scrapedAt).toLocaleString('id-ID')}. Basis utama situs sumber mengacu pada KBBI Edisi III dan merupakan hak cipta Badan Bahasa.</p></section>`;
}

function renderGraph(entry) {
  const svg = $('#relation-graph');
  svg.replaceChildren();
  $('#graph-word').textContent = entry.displayWord || entry.word;
  const limits = { sinonim: 7, antonim: 4, hipernim: 3, hiponim: 2 };
  const visibleByType = Object.fromEntries(Object.entries(limits).map(([type, limit]) => [
    type, entry.relations.filter((item) => item.type === type).slice(0, limit)
  ]));
  const visible = Object.values(visibleByType).flat();
  updateGraphLegend('sinonim', visibleByType.sinonim.length, entry.relations.filter((item) => item.type === 'sinonim').length);
  updateGraphLegend('antonim', visibleByType.antonim.length, entry.relations.filter((item) => item.type === 'antonim').length);
  const hierarchyVisible = visibleByType.hipernim.length + visibleByType.hiponim.length;
  const hierarchyTotal = entry.relations.filter((item) => item.type === 'hipernim' || item.type === 'hiponim').length;
  updateGraphLegend('hierarki', hierarchyVisible, hierarchyTotal);
  $('#graph-empty').textContent = visible.length ? '' : `Relasi visual untuk “${entry.displayWord || entry.word}” belum tersedia.`;
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
    line.setAttribute('class', `graph-line ${item.type === 'sinonim' ? 'sinonim' : item.type === 'antonim' ? 'antonim' : 'other'}`);
    svg.append(line);
    addGraphNode(svg, { x, y, label: item.word, kind: item.type === 'sinonim' ? 'sinonim' : item.type === 'antonim' ? 'antonim' : 'other', slug: item.slug, radius: 31 });
  });
  addGraphNode(svg, { x: cx, y: cy, label: entry.word, kind: 'center', slug: entry.slug, radius: 55 });
}

function updateGraphLegend(type, displayed, total) {
  const item = $(`#legend-${type}`);
  const count = $(`#legend-${type}-count`);
  count.textContent = String(displayed);
  item.classList.toggle('empty', total === 0);
  item.title = total === 0
    ? `Tidak ada ${type} untuk kata terpilih`
    : `${displayed} dari ${total} hubungan ${type} ditampilkan`;
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

function addGraphNode(svg, { x, y, label, kind, slug, radius }) {
  const ns = 'http://www.w3.org/2000/svg';
  const group = document.createElementNS(ns, 'g');
  group.setAttribute('class', `graph-node ${kind}`);
  group.setAttribute('transform', `translate(${x} ${y})`);
  group.setAttribute('tabindex', '0');
  group.setAttribute('role', 'button');
  group.setAttribute('aria-label', label);
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
  title.textContent = label;
  group.append(circle, text, title);
  if (slug) group.addEventListener('click', () => openEntry(slug));
  svg.append(group);
}

function closeModal() {
  $('#entry-modal').classList.remove('open');
  $('#entry-modal').setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
}

async function loadPoster() {
  try {
    const entry = await api('/api/random');
    state.poster = entry;
    $('#poster-word').textContent = entry.word;
    $('#poster-syllables').textContent = entry.syllables || entry.word;
    $('#poster-class').textContent = (entry.wordClassLabel || 'ENTRI').toUpperCase();
    $('#poster-index').textContent = `001 / ${formatNumber(state.stats?.entries || 0)}`;
  } catch { /* Basis data kosong ditangani oleh daftar utama. */ }
}

async function loadFeaturedGraph() {
  const requested = new URLSearchParams(window.location.search).get('word');
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
async function updateSuggestions() {
  const q = $('#search-input').value.trim();
  const container = $('#search-suggestions');
  if (q.length < 2) { container.hidden = true; return; }
  try {
    const result = await api(`/api/words?q=${encodeURIComponent(q)}&limit=6`);
    if (!result.items.length) { container.hidden = true; return; }
    container.innerHTML = result.items.map((item) => `<button type="button" class="suggestion" data-slug="${escapeHtml(item.slug)}"><b>${escapeHtml(item.displayWord)}</b><small>${escapeHtml(item.wordClassLabel)}</small></button>`).join('');
    container.hidden = false;
  } catch { container.hidden = true; }
}

function bindEvents() {
  $('#search-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    state.q = $('#search-input').value.trim();
    $('#search-suggestions').hidden = true;
    await loadWords();
    $('#jelajah').scrollIntoView({ behavior: 'smooth' });
  });
  $('#search-input').addEventListener('input', () => { clearTimeout(suggestionTimer); suggestionTimer = setTimeout(updateSuggestions, 180); });
  $('#search-suggestions').addEventListener('click', (event) => { const button = event.target.closest('[data-slug]'); if (button) openEntry(button.dataset.slug); });
  $('.quick-links').addEventListener('click', (event) => { const button = event.target.closest('[data-query]'); if (!button) return; $('#search-input').value = button.dataset.query; state.q = button.dataset.query; loadWords(); $('#jelajah').scrollIntoView({ behavior: 'smooth' }); });
  $('#word-grid').addEventListener('click', (event) => { const card = event.target.closest('[data-slug]'); if (card) openEntry(card.dataset.slug); });
  $('#entry-content').addEventListener('click', (event) => {
    const graphButton = event.target.closest('[data-view-graph]');
    if (graphButton) {
      closeModal();
      $('#relasi').scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    const button = event.target.closest('[data-slug]');
    if (button && !button.disabled) openEntry(button.dataset.slug);
  });
  $$('[data-close-modal]').forEach((button) => button.addEventListener('click', closeModal));
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeModal(); });
  $('#class-filters').addEventListener('click', (event) => { const button = event.target.closest('[data-class]'); if (!button) return; state.wordClass = button.dataset.class; $$('.class-filter').forEach((item) => item.classList.toggle('active', item === button)); loadWords(); });
  $('#letter-filters').addEventListener('click', (event) => { const button = event.target.closest('[data-letter]'); if (!button || button.disabled) return; state.letter = state.letter === button.dataset.letter ? '' : button.dataset.letter; $$('.letter-filter').forEach((item) => item.classList.toggle('active', item.dataset.letter === state.letter)); loadWords(); });
  $('#reset-filter').addEventListener('click', () => { state.q = ''; state.letter = ''; state.wordClass = ''; $('#search-input').value = ''; $$('.class-filter').forEach((item, i) => item.classList.toggle('active', i === 0)); $$('.letter-filter').forEach((item) => item.classList.remove('active')); loadWords(); });
  $('#load-more').addEventListener('click', () => loadWords({ append: true }));
  $$('.view-toggle button').forEach((button, index) => button.addEventListener('click', () => { state.listMode = index === 1; $$('.view-toggle button').forEach((item, i) => item.classList.toggle('active', i === index)); $('#word-grid').classList.toggle('list', state.listMode); }));
  $$('.nav-link').forEach((button) => button.addEventListener('click', () => { $(`#${button.dataset.section}`).scrollIntoView({ behavior: 'smooth' }); }));
  $('#random-word').addEventListener('click', async () => { const entry = await api('/api/random'); openEntry(entry.slug); });
  $('#open-poster').addEventListener('click', () => state.poster && openEntry(state.poster.slug));
}

async function init() {
  bindEvents();
  try { await loadStats(); } catch (error) { console.error(error); }
  await Promise.all([loadWords(), loadPoster(), loadFeaturedGraph()]);
  setInterval(() => loadStats().catch((error) => console.error(error)), 30_000);
}

init();
