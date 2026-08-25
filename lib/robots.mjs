// Pembacaan robots.txt sesuai kebiasaan umum: kelompok User-agent yang paling
// khusus dipakai, aturan terpanjang menang, dan Allow menang saat panjangnya
// sama. Pemeriksaan "Disallow: /" saja tidak cukup karena situs sumber dapat
// melarang sebagian alamat tanpa melarang seluruh situs.

function patternToRegExp(pattern) {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const escaped = body
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  return new RegExp(`^${escaped}${anchored ? '$' : ''}`);
}

export function parseRobots(text, userAgent = '*') {
  const wanted = userAgent.toLowerCase();
  const groups = new Map();
  let active = [];
  let previousWasAgent = false;

  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const separator = line.indexOf(':');
    if (separator < 0) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (field === 'user-agent') {
      const agent = value.toLowerCase();
      if (!previousWasAgent) active = [];
      if (!groups.has(agent)) groups.set(agent, { rules: [], crawlDelay: 0 });
      active.push(groups.get(agent));
      previousWasAgent = true;
      continue;
    }
    previousWasAgent = false;
    if (!active.length) continue;
    for (const group of active) {
      if (field === 'disallow' && value) group.rules.push({ allow: false, path: value });
      else if (field === 'disallow') group.rules.push({ allow: true, path: '/' });
      else if (field === 'allow' && value) group.rules.push({ allow: true, path: value });
      else if (field === 'crawl-delay') {
        const delay = Number.parseFloat(value);
        if (Number.isFinite(delay) && delay > 0) group.crawlDelay = delay;
      }
    }
  }

  const exact = [...groups.keys()].find((agent) => wanted.includes(agent) && agent !== '*');
  const group = groups.get(exact) ?? groups.get('*') ?? { rules: [], crawlDelay: 0 };
  return {
    rules: group.rules.map((rule) => ({ ...rule, matcher: patternToRegExp(rule.path) })),
    crawlDelay: group.crawlDelay,
    blocksEverything: group.rules.some((rule) => !rule.allow && rule.path === '/')
      && !group.rules.some((rule) => rule.allow && rule.path === '/')
  };
}

export function isAllowed(robots, pathname) {
  let decision = true;
  let best = -1;
  for (const rule of robots.rules) {
    if (!rule.matcher.test(pathname)) continue;
    const length = rule.path.length;
    // Aturan terpanjang menang; bila sama panjang, Allow yang dipakai.
    if (length > best || (length === best && rule.allow)) {
      best = length;
      decision = rule.allow;
    }
  }
  return decision;
}
