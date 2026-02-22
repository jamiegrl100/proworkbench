const ENTITY_MAP = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
};

function decodeEntities(text) {
  let out = String(text || '');
  for (const [k, v] of Object.entries(ENTITY_MAP)) out = out.split(k).join(v);
  out = out.replace(/&#(\d+);/g, (_m, d) => String.fromCharCode(Number(d)));
  return out;
}

function compactWhitespace(text) {
  return String(text || '').replace(/\r/g, '\n').replace(/\t/g, ' ').replace(/[ ]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function normalizeUrl(raw) {
  const text0 = String(raw || '').trim();
  if (!text0) return '';

  // Handle protocol-relative URLs like //example.com
  const text = text0.startsWith('//') ? `https:${text0}` : text0;

  // Handle common relative redirect URLs returned by SERP HTML.
  const candidates = [text];
  if (text.startsWith('/l/?') || text.startsWith('/html/?')) candidates.push(`https://duckduckgo.com${text}`);
  if (text.startsWith('/lite/?')) candidates.push(`https://lite.duckduckgo.com${text}`);
  if (text.startsWith('/RU=') || text.startsWith('/r/') || text.startsWith('/_ylt=')) candidates.push(`https://r.search.yahoo.com${text}`);
  if (text.startsWith('/search?')) candidates.push(`https://search.yahoo.com${text}`);

  for (const cand of candidates) {
    try {
      const u = new URL(cand);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;

      // DuckDuckGo redirect
      if (u.hostname.endsWith('duckduckgo.com') && u.pathname === '/l/' && u.searchParams.get('uddg')) {
        return normalizeUrl(decodeURIComponent(String(u.searchParams.get('uddg') || '')));
      }

      // Jina AI proxy URL
      if (u.hostname === 'r.jina.ai') {
        const p = u.pathname.replace(/^\/+/, '');
        if (/^https?:\/\//i.test(p)) return normalizeUrl(p);
      }

      u.hash = '';
      return u.toString();
    } catch {
      // try next candidate
    }
  }
  return '';
}


export function isLikelyHtml(text) {
  const s = String(text || '');
  if (!s) return false;
  if (/<(?:html|head|body|article|main|script|style)\b/i.test(s)) return true;
  const tags = s.match(/<[^>]+>/g) || [];
  return tags.length >= 10;
}

export function isLikelySerp(text) {
  const s = String(text || '').toLowerCase();
  if (!s) return false;
  const hits = ['duckduckgo', 'search results', 'all regions', 'result__a', 'result__snippet', 'bing'];
  return hits.some((h) => s.includes(h));
}

function pickMainHtml(html) {
  const raw = String(html || '');
  const article = raw.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i);
  if (article?.[1]) return article[1];
  const main = raw.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);
  if (main?.[1]) return main[1];
  const body = raw.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  if (body?.[1]) return body[1];
  return raw;
}

function stripHtmlPreserveBreaks(html) {
  let s = String(html || '');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  s = s.replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');
  s = s.replace(/<(nav|footer|header|aside|menu|form|dialog|svg)\b[\s\S]*?<\/\1>/gi, ' ');
  s = s.replace(/<(br|p|div|li|h1|h2|h3|h4|h5|h6|section|article)\b[^>]*>/gi, '\n');
  s = s.replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);
  return compactWhitespace(s);
}

function cleanBoilerplate(text) {
  const lines = String(text || '').split('\n').map((x) => x.trim()).filter(Boolean);
  const denied = [
    /^all regions\b/i,
    /^safe search\b/i,
    /^any time\b/i,
    /^past day\b/i,
    /^past week\b/i,
    /^privacy\b/i,
    /^terms\b/i,
    /^cookie/i,
    /^sign in\b/i,
    /^feedback\b/i,
  ];
  const out = [];
  for (const ln of lines) {
    if (denied.some((re) => re.test(ln))) continue;
    out.push(ln);
  }
  return compactWhitespace(out.join('\n'));
}

function extractTitle(html) {
  const raw = String(html || '');
  const og = raw.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i);
  if (og?.[1]) return compactWhitespace(decodeEntities(og[1]));
  const t = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (t?.[1]) return compactWhitespace(decodeEntities(t[1]));
  return '';
}

function excerptFromText(text, max = 260) {
  const s = compactWhitespace(text);
  if (!s) return '';
  const parts = s.split(/(?<=[.!?])\s+/).filter(Boolean);
  const first = parts[0] || s;
  return first.slice(0, max);
}

export function trimForContext(text, maxChars = 12000) {
  const limit = Math.max(1000, Number(maxChars) || 12000);
  const paras = compactWhitespace(text).split('\n').map((x) => x.trim()).filter(Boolean);
  const kept = [];
  let total = 0;
  for (const p of paras) {
    if (total >= limit) break;
    const next = p.length + (kept.length ? 2 : 0);
    if (total + next > limit) {
      kept.push(p.slice(0, Math.max(0, limit - total)));
      total = limit;
      break;
    }
    kept.push(p);
    total += next;
  }
  return kept.join('\n\n').trim();
}

export function parseSerpResultsFromHtml(html, { limit = 5 } = {}) {
  const raw = String(html || '');
  const out = [];
  const seen = new Set();
  const max = Math.max(1, Math.min(Number(limit) || 5, 10));

  const push = (url, title, snippet = '') => {
    const u = normalizeUrl(url);
    if (!u || seen.has(u)) return;
    const t = compactWhitespace(stripHtmlPreserveBreaks(title || '')).slice(0, 200);
    if (!t || /^(next|more|privacy|terms|sign\s*in|log\s*in|settings|feedback)$/i.test(t)) return;
    seen.add(u);
    const sn = compactWhitespace(stripHtmlPreserveBreaks(snippet || '')).slice(0, 260);
    out.push({ url: u, title: t, snippet: sn });
  };

  // DuckDuckGo "html" results: attribute order varies, href is often relative (/l/?uddg=...)
  const ddgAnchor = /<a\b(?=[^>]*\bresult__a\b)[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = ddgAnchor.exec(raw)) && out.length < max) {
    const tag = m[0];
    const href = (tag.match(/\bhref=["']([^"']+)["']/i) || [])[1] || '';
    const title = m[1] || '';
    const after = raw.slice(ddgAnchor.lastIndex, ddgAnchor.lastIndex + 800);
    const sn = (after.match(/(?:result__snippet)[^>]*>([\s\S]*?)<\//i) || [])[1] || '';
    push(href, title, sn);
  }

  // DuckDuckGo lite results
  if (out.length === 0) {
    const ddgLite = /<a\b[^>]*class=["'][^"']*result-link[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>[\s\S]{0,500}?(?:<td[^>]*class=["'][^"']*result-snippet[^"']*["'][^>]*>([\s\S]*?)<\/td>)?/gi;
    while ((m = ddgLite.exec(raw)) && out.length < max) push(m[1], m[2], m[3] || '');
  }

  // Yahoo / broad link extraction with filtering
  if (out.length === 0) {
    const links = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    while ((m = links.exec(raw)) && out.length < max) {
      const href = m[1];
      const title = m[2];
      const u = normalizeUrl(href);
      if (!u) continue;
      try {
        const hu = new URL(u);
        const host = hu.hostname.toLowerCase();
        if (
          host.endsWith('duckduckgo.com') ||
          host.endsWith('google.com') ||
          host.endsWith('bing.com') ||
          host === 't.co' ||
          host.endsWith('.t.co') ||
          host.endsWith('search.yahoo.com') ||
          host.endsWith('r.search.yahoo.com')
        ) continue;
      } catch { continue; }
      push(href, title, '');
    }
  }

  return out.slice(0, max);
}


export function extractReadableText(html, { maxChars = 12000 } = {}) {
  const raw = String(html || '');
  const title = extractTitle(raw);
  const main = pickMainHtml(raw);
  const text0 = stripHtmlPreserveBreaks(main);
  const text = trimForContext(cleanBoilerplate(text0), maxChars);
  const excerpt = excerptFromText(text);
  return { title, text, excerpt };
}

export function normalizeMcpResult({ url = '', content = '', maxChars = 12000 } = {}) {
  const raw = String(content || '');
  const htmlLike = isLikelyHtml(raw);
  const serpLike = isLikelySerp(raw);
  const normalizedUrl = normalizeUrl(url) || String(url || '').trim();

  if (!raw.trim()) {
    return {
      url: normalizedUrl,
      cleanText: '',
      title: '',
      excerpt: '',
      serp: false,
      serpResults: [],
      normalized: false,
      reason: 'empty',
    };
  }

  if (htmlLike && serpLike) {
    const serpResults = parseSerpResultsFromHtml(raw, { limit: 5 });
    const lines = ['Top results:'];
    for (const r of serpResults) {
      const snippet = r.snippet ? ` — ${r.snippet}` : '';
      lines.push(`- ${r.title || r.url}: ${r.url}${snippet}`);
    }
    return {
      url: normalizedUrl,
      cleanText: trimForContext(lines.join('\n'), maxChars),
      title: 'Search results',
      excerpt: lines[1] || '',
      serp: true,
      serpResults,
      normalized: true,
      reason: 'serp_html',
    };
  }

  if (htmlLike) {
    const rr = extractReadableText(raw, { maxChars });
    return {
      url: normalizedUrl,
      cleanText: rr.text,
      title: rr.title,
      excerpt: rr.excerpt,
      serp: false,
      serpResults: [],
      normalized: true,
      reason: 'html',
    };
  }

  return {
    url: normalizedUrl,
    cleanText: trimForContext(cleanBoilerplate(raw), maxChars),
    title: '',
    excerpt: excerptFromText(raw),
    serp: false,
    serpResults: [],
    normalized: false,
    reason: 'plain',
  };
}
