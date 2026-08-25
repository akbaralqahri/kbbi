import { setTimeout as sleep } from 'node:timers/promises';
import { db, getMeta, setMeta, upsertEntry } from '../lib/db.mjs';
import { parseEntryPage, parseSitemap } from '../lib/parser.mjs';
import { slugFromUrl } from '../lib/text.mjs';

const BASE = 'https://kbbi.web.id';
const SITEMAP = `${BASE}/sitemap.xml`;
const USER_AGENT = 'RuangKata/1.0 (local educational dashboard; respectful crawler)';

function parseArgs(argv) {
  const options = {
    all: false,
    limit: 30,
    concurrency: 1,
    delay: 1500,
    refresh: false,
    slugs: []
  };
  for (const arg of argv) {
    if (arg === '--all') { options.all = true; options.limit = Number.POSITIVE_INFINITY; }
    else if (arg === '--refresh') options.refresh = true;
    else if (arg.startsWith('--limit=')) options.limit = Math.max(1, Number(arg.slice(8)) || 30);
    else if (arg.startsWith('--concurrency=')) options.concurrency = Math.min(4, Math.max(1, Number(arg.slice(14)) || 2));
    else if (arg.startsWith('--delay=')) options.delay = Math.max(400, Number(arg.slice(8)) || 950);
    else if (arg.startsWith('--slugs=')) options.slugs = arg.slice(8).split(',').map((item) => item.trim()).filter(Boolean);
  }
  return options;
}

async function fetchText(url, attempts = 4) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xml;q=0.9,*/*;q=0.5' },
        signal: AbortSignal.timeout(30_000)
      });
      if (response.ok) return await response.text();
      if (response.status !== 429 && response.status < 500) throw new Error(`HTTP ${response.status}`);
      const retryAfter = Number(response.headers.get('retry-after')) * 1_000;
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : attempt * 2_000);
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(attempt * 1_500);
    }
  }
  throw lastError;
}

async function ensureCrawlAllowed() {
  let robots;
  try {
    robots = await fetchText(`${BASE}/robots.txt`, 5);
  } catch (error) {
    // Hanya gunakan hasil pemeriksaan lama bila sebelumnya robots.txt sudah berhasil dibaca.
    if (getMeta('robots_allowed') === 'true') {
      console.warn(`robots.txt sementara tidak dapat diakses (${error.message}); memakai hasil pemeriksaan sebelumnya.`);
      return;
    }
    throw error;
  }
  const disallowRoot = /user-agent:\s*\*[\s\S]*?disallow:\s*\/\s*(?:\r?\n|$)/i.test(robots);
  if (disallowRoot) throw new Error('robots.txt melarang pengambilan data. Proses dihentikan.');
  setMeta('robots_allowed', 'true');
  setMeta('robots_checked_at', new Date().toISOString());
}

async function enqueueSitemap(refresh = false) {
  const known = Number(getMeta('sitemap_url_count', 0));
  if (known && !refresh) return known;
  console.log('Mengambil sitemap resmi...');
  const urls = parseSitemap(await fetchText(SITEMAP));
  const insert = db.prepare(`
    INSERT OR IGNORE INTO crawl_queue(url, slug, state, attempts, queued_at, updated_at)
    VALUES (?, ?, 'pending', 0, ?, ?)
  `);
  const now = new Date().toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const url of urls) insert.run(url, slugFromUrl(url), now, now);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  setMeta('sitemap_url_count', urls.length);
  setMeta('sitemap_fetched_at', now);
  console.log(`${urls.length.toLocaleString('id-ID')} URL masuk ke antrean.`);
  return urls.length;
}

function selectJobs(options) {
  if (options.slugs.length) {
    const jobs = [];
    const add = db.prepare(`
      INSERT OR IGNORE INTO crawl_queue(url, slug, state, attempts, queued_at, updated_at)
      VALUES (?, ?, 'pending', 0, ?, ?)
    `);
    const get = db.prepare('SELECT url, slug FROM crawl_queue WHERE slug = ? LIMIT 1');
    const now = new Date().toISOString();
    for (const slug of options.slugs) {
      const url = `${BASE}/${encodeURIComponent(slug).replace(/%2F/gi, '/')}`;
      add.run(url, slug, now, now);
      const job = get.get(slug);
      if (job) jobs.push(job);
    }
    return jobs;
  }
  const limit = Number.isFinite(options.limit) ? options.limit : 1_000_000;
  const stateClause = options.refresh ? "state IN ('pending','done','error')" : "state IN ('pending','error')";
  return db.prepare(`
    SELECT url, slug FROM crawl_queue
    WHERE ${stateClause} AND attempts < 5
    ORDER BY CASE state WHEN 'pending' THEN 0 ELSE 1 END, attempts ASC, updated_at
    LIMIT ?
  `).all(limit);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  // Memulihkan pekerjaan yang tertinggal bila proses sebelumnya dimatikan paksa.
  db.prepare("UPDATE crawl_queue SET state='pending', updated_at=? WHERE state='working'").run(new Date().toISOString());
  if (getMeta('crawl_state') === 'running') setMeta('crawl_state', 'paused');
  await ensureCrawlAllowed();
  await enqueueSitemap(options.refresh);
  const jobs = selectJobs(options);
  if (!jobs.length) {
    console.log('Tidak ada entri yang perlu diambil.');
    return;
  }

  const markWorking = db.prepare("UPDATE crawl_queue SET state='working', attempts=attempts+1, updated_at=? WHERE url=?");
  const markDone = db.prepare("UPDATE crawl_queue SET state='done', last_error=NULL, updated_at=? WHERE url=?");
  const markSkipped = db.prepare("UPDATE crawl_queue SET state='skipped', last_error=?, updated_at=? WHERE url=?");
  const markError = db.prepare("UPDATE crawl_queue SET state='error', last_error=?, updated_at=? WHERE url=?");
  let cursor = 0;
  let completed = 0;
  let failed = 0;
  let skipped = 0;
  let consecutiveFailures = 0;
  let stopping = false;
  const startedAt = Date.now();

  const handleStop = () => { stopping = true; console.log('\nMenghentikan dengan aman setelah permintaan aktif selesai...'); };
  process.once('SIGINT', handleStop);
  process.once('SIGTERM', handleStop);
  setMeta('crawl_state', 'running');
  setMeta('crawl_started_at', new Date().toISOString());
  setMeta('crawl_processed_this_run', 0);
  setMeta('crawl_last_activity_at', new Date().toISOString());

  async function worker(number) {
    while (!stopping) {
      const index = cursor++;
      if (index >= jobs.length) return;
      const job = jobs[index];
      const now = new Date().toISOString();
      markWorking.run(now, job.url);
      try {
        const html = await fetchText(job.url);
        const entry = parseEntryPage(html, { slug: job.slug, sourceUrl: job.url });
        upsertEntry(entry);
        markDone.run(new Date().toISOString(), job.url);
        completed += 1;
        consecutiveFailures = 0;
      } catch (error) {
        const message = String(error.message ?? error).slice(0, 500);
        if (/lema utama tidak ditemukan|#d1 tidak ditemukan/i.test(message)) {
          markSkipped.run(message, new Date().toISOString(), job.url);
          skipped += 1;
          consecutiveFailures = 0;
        } else {
          failed += 1;
          consecutiveFailures += 1;
          markError.run(message, new Date().toISOString(), job.url);
        }
      }
      const processed = completed + failed + skipped;
      if (processed % 10 === 0 || processed === jobs.length) {
        const elapsed = Math.max(1, (Date.now() - startedAt) / 1000);
        const rate = processed / elapsed;
        console.log(`[${processed}/${jobs.length}] berhasil=${completed} dilewati=${skipped} gagal=${failed} laju=${rate.toFixed(2)}/dtk (pekerja ${number})`);
        setMeta('crawl_processed_this_run', processed);
        setMeta('crawl_last_activity_at', new Date().toISOString());
      }
      if (consecutiveFailures >= 3) {
        console.warn('Tiga kegagalan koneksi beruntun; menunggu 60 detik sebelum melanjutkan.');
        setMeta('crawl_state', 'waiting');
        await sleep(60_000);
        setMeta('crawl_state', 'running');
        consecutiveFailures = 0;
      }
      await sleep(options.delay);
    }
  }

  await Promise.all(Array.from({ length: options.concurrency }, (_, index) => worker(index + 1)));
  db.prepare("UPDATE crawl_queue SET state='pending', updated_at=? WHERE state='working'").run(new Date().toISOString());
  setMeta('crawl_state', stopping ? 'paused' : 'idle');
  setMeta('crawl_last_finished_at', new Date().toISOString());
  console.log(`Selesai. ${completed} berhasil, ${skipped} dilewati, ${failed} gagal.`);
}

async function runPersistently() {
  while (true) {
    try {
      setMeta('crawl_error', '');
      await main();
      return;
    } catch (error) {
      setMeta('crawl_state', 'error');
      setMeta('crawl_error', error.message);
      console.error(error);
      if (/robots\.txt melarang/i.test(error.message)) {
        process.exitCode = 1;
        return;
      }
      console.warn('Scraper akan mencoba memulai kembali dalam 60 detik.');
      await sleep(60_000);
    }
  }
}

runPersistently();
