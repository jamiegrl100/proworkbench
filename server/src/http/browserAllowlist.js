import express from 'express';
import { requireAuth } from './middleware.js';
import { addBrowserAllowlistDomain, assertNavigationAllowed, getBrowserAllowlist, normalizeDomainRules, removeBrowserAllowlistDomain, setBrowserAllowlist } from '../browser/allowlist.js';
import { recordEvent } from '../util/events.js';

function parseHtmlAttrs(tag) {
  const attrs = {};
  const re = /([a-zA-Z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  let m;
  while ((m = re.exec(tag))) {
    const key = String(m[1] || '').toLowerCase();
    const val = m[2] ?? m[3] ?? m[4] ?? '';
    attrs[key] = String(val || '');
  }
  return attrs;
}

function parseHtmlFields(html) {
  const out = [];
  const push = (kind, attrs) => {
    const type = String(attrs.type || (kind === 'textarea' ? 'textarea' : kind === 'select' ? 'select' : 'text')).toLowerCase();
    const key = String(attrs.name || attrs.id || attrs['aria-label'] || attrs.placeholder || `${kind}_${out.length + 1}`).trim();
    if (!key) return;
    out.push({ key, kind, type, name: attrs.name || '', id: attrs.id || '', placeholder: attrs.placeholder || '' });
  };

  for (const m of html.matchAll(/<input\b[^>]*>/gi)) push('input', parseHtmlAttrs(m[0]));
  for (const m of html.matchAll(/<textarea\b[^>]*>/gi)) push('textarea', parseHtmlAttrs(m[0]));
  for (const m of html.matchAll(/<select\b[^>]*>/gi)) push('select', parseHtmlAttrs(m[0]));
  return out.slice(0, 200);
}

function valueForField(field, profile) {
  const p = profile && typeof profile === 'object' ? profile : {};
  const hay = `${field.key} ${field.name || ''} ${field.id || ''} ${field.placeholder || ''}`.toLowerCase();
  const get = (...keys) => {
    for (const k of keys) {
      if (p[k] != null && String(p[k]).trim()) return String(p[k]);
    }
    return '';
  };
  if (/(email|e-mail)/.test(hay)) return get('contactEmail', 'email');
  if (/(site|website|url|domain|homepage)/.test(hay)) return get('siteUrl', 'url');
  if (/(name|title|company|business)/.test(hay)) return get('siteName', 'name');
  if (/(desc|about|summary|bio)/.test(hay)) return get('siteDescriptionLong', 'siteDescriptionShort', 'description');
  if (/keyword/.test(hay)) return get('keywords');
  if (/categor/.test(hay)) return get('category');
  if (/country|location|region/.test(hay)) return get('country');
  if (/rss/.test(hay)) return get('rssUrl');
  if (/(logo|image|avatar)/.test(hay)) return get('logoUrl');
  return '';
}

async function fetchHtml(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      headers: { 'user-agent': 'Proworkbench-Browser-Automation/1.0' },
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      const err = new Error(`prefill_fetch_failed_http_${res.status}`);
      err.code = 'PREFILL_FETCH_FAILED';
      throw err;
    }
    return { html: String(text || ''), finalUrl: res.url || url };
  } finally {
    clearTimeout(t);
  }
}


export function createBrowserAllowlistRouter({ db }) {
  const r = express.Router();
  r.use(requireAuth(db));


  r.post('/prefill', async (req, res) => {
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const targetUrl = String(body.targetUrl || '').trim();
      if (!targetUrl) return res.status(400).json({ ok: false, error: 'targetUrl required' });
      const profile = body.profile && typeof body.profile === 'object' ? body.profile : {};
      const options = body.options && typeof body.options === 'object' ? body.options : {};
      const policy = body.policy && typeof body.policy === 'object' ? body.policy : {};
      const rules = normalizeDomainRules(Array.isArray(policy.allowedDomains) ? policy.allowedDomains : getBrowserAllowlist(db));
      await assertNavigationAllowed({ url: targetUrl, allowRules: rules });

      let html = '';
      let finalUrl = targetUrl;
      let fetchWarning = '';
      try {
        const fetched = await fetchHtml(targetUrl);
        html = String(fetched.html || '');
        finalUrl = fetched.finalUrl || targetUrl;
        await assertNavigationAllowed({ url: finalUrl || targetUrl, allowRules: rules });
      } catch (e) {
        fetchWarning = String(e?.message || e);
        recordEvent(db, 'directory_assistant.prefill.fetch_warning', {
          targetUrl,
          reason: fetchWarning.slice(0, 180),
        });
      }

      let fields = parseHtmlFields(html);
      if (!fields.length) {
        fields = [
          { key: 'site_name', kind: 'input', type: 'text', name: 'site_name', id: '', placeholder: 'Site Name' },
          { key: 'site_url', kind: 'input', type: 'url', name: 'site_url', id: '', placeholder: 'Site URL' },
          { key: 'contact_email', kind: 'input', type: 'email', name: 'contact_email', id: '', placeholder: 'Contact Email' },
          { key: 'category', kind: 'input', type: 'text', name: 'category', id: '', placeholder: 'Category' },
          { key: 'description', kind: 'textarea', type: 'textarea', name: 'description', id: '', placeholder: 'Description' },
        ];
      }

      const prefillMap = {};
      for (const f of fields) {
        const val = valueForField(f, profile);
        if (val) prefillMap[f.key] = val;
      }
      const captchaDetected = html ? /(captcha|hcaptcha|recaptcha)/i.test(html) : false;
      const result = {
        ok: true,
        action: 'prefill',
        finalUrl,
        captchaDetected,
        fieldsDetected: fields,
        prefillMap,
        screenshotPath: null,
        warning: fetchWarning || null,
        message: fetchWarning
          ? 'Prefill preview generated using safe fallback fields. Review manually before submit.'
          : (options.fillFields === false
            ? 'Dry-run detection complete.'
            : 'Prefill mapping generated. Review before submit.'),
      };
      return res.json(result);
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e?.message || e), code: String(e?.code || 'PREFILL_FAILED') });
    }
  });

  r.get('/allowlist', (_req, res) => {
    try {
      res.json({ ok: true, domains: getBrowserAllowlist(db) });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.post('/allowlist', (req, res) => {
    try {
      const domains = Array.isArray(req.body?.domains) ? req.body.domains : null;
      const domain = req.body?.domain != null ? String(req.body.domain) : '';
      const next = domains ? setBrowserAllowlist(db, domains) : addBrowserAllowlistDomain(db, domain);
      recordEvent(db, 'browser_allowlist.updated', { mode: domains ? 'replace' : 'add', domain: domain || null, count: next.length });
      res.json({ ok: true, domains: next });
    } catch (e) {
      res.status(400).json({ ok: false, error: String(e?.message || e), code: String(e?.code || 'ALLOWLIST_UPDATE_FAILED') });
    }
  });

  r.delete('/allowlist', (req, res) => {
    try {
      const domain = String(req.body?.domain || req.query?.domain || '').trim();
      if (!domain) return res.status(400).json({ ok: false, error: 'domain required' });
      const next = removeBrowserAllowlistDomain(db, domain);
      recordEvent(db, 'browser_allowlist.updated', { mode: 'remove', domain, count: next.length });
      res.json({ ok: true, domains: next });
    } catch (e) {
      res.status(400).json({ ok: false, error: String(e?.message || e), code: String(e?.code || 'ALLOWLIST_UPDATE_FAILED') });
    }
  });

  return r;
}
