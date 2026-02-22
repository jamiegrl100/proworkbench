const API_BASE = '/admin/plugins/directory-assistant';
const BROWSER_API_BASE = '/api/browser';
let state = {
  targets: [],
  attempts: [],
  profiles: [],
  browserServers: [],
  settings: null,
  selectedId: null,
  selectedProfileId: null,
  globalAllowlist: [],
  projects: [],
  activeProjectId: '',
  hideSubmitted: true,
  vettedOnly: false,
  pricingFilter: '',
  selectedTargetIds: new Set(),
  lastApprovalRequestId: '',
  restoredUiState: false,
  selectedBrowserServerId: '',
  prefillPreflight: null,
};

function token() {
  return localStorage.getItem('pb_admin_token') || '';
}

function sessionId() {
  const key = 'pb_da_session_id';
  let id = localStorage.getItem(key) || '';
  if (!id) {
    id = 'da_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem(key, id);
  }
  return id;
}

async function api(path, opts = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...opts,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token()}`,
      ...(opts.headers || {}),
    },
  });
  const txt = await res.text();
  const body = txt ? (() => { try { return JSON.parse(txt); } catch { return { ok: false, error: txt }; } })() : {};
  if (!res.ok || body.ok === false) {
    const e = new Error(body.error || `HTTP ${res.status}`);
    e.code = body.code || '';
    e.detail = body;
    throw e;
  }
  return body;
}

async function browserApi(path, opts = {}) {
  const res = await fetch(`${BROWSER_API_BASE}${path}`, {
    ...opts,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token()}`,
      ...(opts.headers || {}),
    },
  });
  const txt = await res.text();
  const body = txt ? (() => { try { return JSON.parse(txt); } catch { return { ok: false, error: txt }; } })() : {};
  if (!res.ok || body.ok === false) {
    const e = new Error(body.error || `HTTP ${res.status}`);
    e.code = body.code || '';
    e.detail = body;
    throw e;
  }
  return body;
}

function byId(id) { return document.getElementById(id); }
function toast(msg, cls = '') {
  const el = byId('toast');
  el.textContent = msg;
  el.className = `pill ${cls}`;
  el.style.display = 'inline-flex';
  setTimeout(() => { el.style.display = 'none'; }, 3000);
}

function selectedTarget() {
  return state.targets.find((x) => x.id === state.selectedId) || null;
}

function getVisibleTargets() {
  const search = (byId('searchInput').value || '').toLowerCase().trim();
  const status = byId('statusFilter').value;
  return state.targets.filter((t) => {
    if (status && String(t.projectStatus || 'new') !== status) return false;
    if (state.pricingFilter && String(t.pricingStatus || 'unknown') !== state.pricingFilter) return false;
    if (state.vettedOnly && !Boolean(t.vetted)) return false;
    if (search && !(String(t.url).toLowerCase().includes(search) || String(t.domain).toLowerCase().includes(search) || String(t.notes || '').toLowerCase().includes(search))) return false;
    return true;
  });
}

const UI_STATE_KEY = 'pb_da_ui_state_v1';

function saveUiState() {
  try {
    const box = byId('targetsTable')?.closest('.box');
    const payload = {
      selectedId: state.selectedId || '',
      selectedProfileId: state.selectedProfileId || '',
      activeProjectId: state.activeProjectId || '',
      hideSubmitted: !!state.hideSubmitted,
      vettedOnly: !!state.vettedOnly,
      pricingFilter: state.pricingFilter || '',
      search: byId('searchInput')?.value || '',
      statusFilter: byId('statusFilter')?.value || '',
      submitNote: byId('submitNote')?.value || '',
      selNotes: byId('selNotes')?.value || '',
      selTags: byId('selTags')?.value || '',
      scrollTop: box ? Number(box.scrollTop || 0) : 0,
      ts: Date.now(),
    };
    localStorage.setItem(UI_STATE_KEY, JSON.stringify(payload));
  } catch {}
}

function restoreUiStateIfAny() {
  if (state.restoredUiState) return;
  state.restoredUiState = true;
  try {
    const raw = localStorage.getItem(UI_STATE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (saved && typeof saved === 'object') {
      if (saved.selectedId) state.selectedId = String(saved.selectedId);
      if (saved.selectedProfileId) state.selectedProfileId = String(saved.selectedProfileId);
      if (saved.activeProjectId) state.activeProjectId = String(saved.activeProjectId);
      if (saved.hideSubmitted !== undefined) state.hideSubmitted = !!saved.hideSubmitted;
      if (saved.vettedOnly !== undefined) state.vettedOnly = !!saved.vettedOnly;
      if (saved.pricingFilter !== undefined) state.pricingFilter = String(saved.pricingFilter || '');
      if (byId('searchInput') && saved.search !== undefined) byId('searchInput').value = String(saved.search || '');
      if (byId('statusFilter') && saved.statusFilter !== undefined) byId('statusFilter').value = String(saved.statusFilter || '');
      if (byId('submitNote') && saved.submitNote !== undefined) byId('submitNote').value = String(saved.submitNote || '');
      if (byId('selNotes') && saved.selNotes !== undefined) byId('selNotes').value = String(saved.selNotes || '');
      if (byId('selTags') && saved.selTags !== undefined) byId('selTags').value = String(saved.selTags || '');
      requestAnimationFrame(() => {
        try {
          const box = byId('targetsTable')?.closest('.box');
          if (box && Number.isFinite(Number(saved.scrollTop || 0))) box.scrollTop = Number(saved.scrollTop || 0);
        } catch {}
      });
    }
  } catch {}
}

function applyProfileToForm(p) {
  const x = p || {};
  byId('p_siteName').value = x.site_name || '';
  byId('p_siteUrl').value = x.site_url || '';
  byId('p_contactEmail').value = x.contact_email || '';
  byId('p_category').value = x.category || '';
  byId('p_keywords').value = x.keywords || '';
  byId('p_country').value = x.country || '';
  byId('p_rssUrl').value = x.rss_url || '';
  byId('p_logoUrl').value = x.logo_url || '';
  byId('p_descShort').value = x.site_description_short || '';
  byId('p_descLong').value = x.site_description_long || '';
}

function readProfileForm() {
  return {
    id: state.selectedProfileId || undefined,
    siteName: byId('p_siteName').value,
    siteUrl: byId('p_siteUrl').value,
    contactEmail: byId('p_contactEmail').value,
    category: byId('p_category').value,
    keywords: byId('p_keywords').value,
    country: byId('p_country').value,
    rssUrl: byId('p_rssUrl').value,
    logoUrl: byId('p_logoUrl').value,
    siteDescriptionShort: byId('p_descShort').value,
    siteDescriptionLong: byId('p_descLong').value,
    socialLinks: {},
  };
}

function renderTargets() {
  const tbody = byId('targetsTable').querySelector('tbody');
  tbody.innerHTML = '';
  const rows = getVisibleTargets();
  for (const row of rows) {
    const tr = document.createElement('tr');
    tr.style.cursor = 'pointer';
    tr.style.background = row.id === state.selectedId ? 'color-mix(in srgb, var(--accent2) 10%, var(--panel))' : 'transparent';

    const checked = state.selectedTargetIds.has(row.id);
    const status = String(row.projectStatus || 'new');
    const pricing = String(row.pricingStatus || 'unknown');
    const vetted = Boolean(row.vetted) ? 'vetted' : 'unvetted';

    tr.innerHTML = `<td><input type="checkbox" data-id="${row.id}" ${checked ? 'checked' : ''} /></td><td>${row.url}</td><td><span class="pill">${status}</span></td><td>${pricing}</td><td>${vetted}</td>`;
    tr.onclick = (ev) => {
      const target = ev.target;
      if (target && target.tagName === 'INPUT') return;
      state.selectedId = row.id;
      renderDetails();
      renderTargets();
      saveUiState();
      loadAttempts();
    };
    tbody.appendChild(tr);
  }

  for (const cb of tbody.querySelectorAll('input[type="checkbox"][data-id]')) {
    cb.onchange = () => {
      const id = String(cb.getAttribute('data-id') || '');
      if (!id) return;
      if (cb.checked) state.selectedTargetIds.add(id); else state.selectedTargetIds.delete(id);
      saveUiState();
      const selectedCount = byId('bulkSelectedCount');
      if (selectedCount) selectedCount.textContent = `${state.selectedTargetIds.size} selected`;
    };
  }

  const selectedCount = byId('bulkSelectedCount');
  if (selectedCount) selectedCount.textContent = `${state.selectedTargetIds.size} selected`;
}

function renderProfiles() {
  const sel = byId('profileSelect');
  sel.innerHTML = '';
  for (const p of state.profiles) {
    const o = document.createElement('option');
    o.value = p.id;
    o.textContent = `${p.site_name || '(unnamed)'} (${p.site_url || 'no-url'})`;
    sel.appendChild(o);
  }
  if (state.selectedProfileId && state.profiles.some((x) => x.id === state.selectedProfileId)) sel.value = state.selectedProfileId;
}

function renderProjects() {
  const sel = byId('projectSelect');
  if (!sel) return;
  sel.innerHTML = '';
  for (const p of state.projects || []) {
    const o = document.createElement('option');
    o.value = p.id;
    o.textContent = `${p.name}${p.primaryDomain ? ` (${p.primaryDomain})` : ''}`;
    sel.appendChild(o);
  }
  if (state.activeProjectId && (state.projects || []).some((x) => x.id === state.activeProjectId)) {
    sel.value = state.activeProjectId;
  }
}

function renderBrowserServers() {
  const sel = byId('browserServerSelect');
  if (!sel) return;
  sel.innerHTML = '';
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = state.browserServers.length ? 'Select browser automation server' : 'No Browser Automation server found';
  sel.appendChild(placeholder);
  for (const s of state.browserServers) {
    const o = document.createElement('option');
    o.value = s.id;
    o.textContent = `${s.name} (${s.status}, ${s.lastTestStatus || 'never'})`;
    sel.appendChild(o);
  }
  const chosen = String(state.selectedBrowserServerId || (state.settings && state.settings.browserServerId) || '');
  if (chosen) sel.value = chosen;
}

function renderDetails() {
  const t = selectedTarget();
  byId('selectedHint').style.display = t ? 'none' : 'block';
  byId('details').style.display = t ? 'grid' : 'none';
  if (!t) return;
  byId('selUrl').textContent = `${t.url} (${t.domain})`;
  byId('selStatus').value = t.projectStatus || 'new';
  byId('selType').value = t.type;
  byId('selNotes').value = t.notes || '';
  byId('selTags').value = Array.isArray(t.tags) ? t.tags.join(', ') : '';
  if (byId('selPricingStatus')) byId('selPricingStatus').value = t.pricingStatus || 'unknown';
  if (byId('selCost')) byId('selCost').value = t.cost || '';
  if (byId('selVetted')) byId('selVetted').checked = !!t.vetted;
  if (byId('selProjectTags')) byId('selProjectTags').value = Array.isArray(t.projectTags) ? t.projectTags.join(', ') : '';
}

function renderAttempts() {
  const tbody = byId('attemptsTable').querySelector('tbody');
  tbody.innerHTML = '';
  for (const a of state.attempts) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${a.attempted_at || ''}</td><td>${a.target_id || ''}</td><td>${a.result || ''}</td><td>${a.error || ''}</td>`;
    tbody.appendChild(tr);
  }
}

function renderSettings() {
  const s = state.settings || {};
  byId('prefillEnabled').checked = !!s.prefillEnabled;
  if (byId('requireSubmitApprovals')) byId('requireSubmitApprovals').checked = s.requireApprovalsForSubmitActions !== false;
  byId('maxPrefillPerDay').value = Number(s.maxPrefillPerDay || 25);
  byId('throttleSeconds').value = Number(s.throttleSeconds || 15);
  byId('loggingVerbosity').value = s.loggingVerbosity || 'normal';
  byId('exportPath').value = s.exportPath || '.pb/directory-assistant/exports';
  renderBrowserServers();
}


function renderPrefillPreflight() {
  const banner = byId('prefillServerBanner');
  const runBtn = byId('requestPrefillBtn');
  const cfgBtn = byId('prefillConfigureBtn');
  const selectedId = String(state.selectedBrowserServerId || byId('browserServerSelect')?.value || '');
  const pre = state.prefillPreflight;

  if (!selectedId) {
    if (banner) {
      banner.style.display = 'block';
      banner.style.color = 'var(--warn)';
      banner.textContent = 'Prefill unavailable: select a Browser Automation server in Settings.';
    }
    if (runBtn) runBtn.disabled = true;
    if (cfgBtn) cfgBtn.disabled = true;
    return;
  }

  if (!pre || pre.serverId !== selectedId) {
    if (banner) {
      banner.style.display = 'block';
      banner.style.color = 'var(--muted)';
      banner.textContent = 'Checking browser server capabilities...';
    }
    if (runBtn) runBtn.disabled = true;
    if (cfgBtn) cfgBtn.disabled = false;
    return;
  }

  if (pre.ready) {
    if (banner) {
      banner.style.display = 'none';
      banner.textContent = '';
    }
    if (runBtn) runBtn.disabled = false;
    if (cfgBtn) cfgBtn.disabled = false;
    return;
  }

  const missing = Array.isArray(pre.missing) ? pre.missing.join(', ') : 'prefill';
  if (banner) {
    banner.style.display = 'block';
    banner.style.color = 'var(--warn)';
    banner.textContent = `Prefill unavailable: Browser Automation server is missing ${missing} capability configuration.`;
  }
  if (runBtn) runBtn.disabled = true;
  if (cfgBtn) cfgBtn.disabled = false;
}

async function runPrefillPreflight() {
  const selectedId = String(state.selectedBrowserServerId || byId('browserServerSelect')?.value || '');
  state.prefillPreflight = selectedId ? { serverId: selectedId, checking: true, ready: false, missing: [] } : null;
  renderPrefillPreflight();
  if (!selectedId) return;
  try {
    const projectId = String(state.activeProjectId || '');
    const qs = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
    const out = await api(`/browser-servers/${encodeURIComponent(selectedId)}/capabilities${qs}`);
    state.prefillPreflight = {
      serverId: selectedId,
      checking: false,
      ready: !!out.ready,
      missing: Array.isArray(out.missing) ? out.missing : [],
      capabilities: out.capabilities || {},
      endpointConfig: out.endpointConfig || {},
    };
  } catch (e) {
    state.prefillPreflight = {
      serverId: selectedId,
      checking: false,
      ready: false,
      missing: ['prefill'],
      error: e.message || 'Preflight failed',
    };
  }
  renderPrefillPreflight();
}

function renderGlobalAllowlist() {
  const box = byId('allowlistList');
  const errEl = byId('allowlistError');
  if (!box) return;
  if (errEl) errEl.textContent = '';
  const rows = state.globalAllowlist || [];
  if (!rows.length) {
    box.innerHTML = '<div class="muted">No domains allowed yet.</div>';
    return;
  }
  box.innerHTML = '';
  for (const domain of rows) {
    const row = document.createElement('div');
    row.className = 'row';
    row.style.justifyContent = 'space-between';
    row.style.alignItems = 'center';
    row.innerHTML = `<code>${domain}</code>`;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Remove';
    btn.onclick = async () => {
      try {
        const out = await browserApi('/allowlist', {
          method: 'DELETE',
          body: JSON.stringify({ domain }),
        });
        state.globalAllowlist = out.domains || [];
        renderGlobalAllowlist();
      } catch (e) {
        if (errEl) errEl.textContent = e.message || 'Remove failed';
      }
    };

    row.appendChild(btn);
    box.appendChild(row);
  }
}

async function loadState() {
  const [stateRes, allowlistRes] = await Promise.all([
    api('/state'),
    browserApi('/allowlist'),
  ]);

  state.profiles = stateRes.profiles || [];
  state.browserServers = stateRes.browserServers || [];
  state.settings = stateRes.settings || null;
  state.selectedBrowserServerId = String(stateRes.selectedBrowserServerId || state.settings?.browserServerId || state.selectedBrowserServerId || '');
  state.projects = stateRes.projects || [];
  state.activeProjectId = String(stateRes.activeProjectId || state.settings?.currentProjectId || state.activeProjectId || '');
  state.globalAllowlist = allowlistRes.domains || [];
  const hideSubmitted = byId('hideSubmitted');
  if (hideSubmitted) hideSubmitted.checked = !!state.hideSubmitted;
  const pricingFilter = byId('pricingFilter');
  if (pricingFilter) pricingFilter.value = state.pricingFilter || '';
  const vettedOnly = byId('vettedOnly');
  if (vettedOnly) vettedOnly.checked = !!state.vettedOnly;
  if (!state.selectedProfileId && state.profiles[0]) state.selectedProfileId = state.profiles[0].id;

  const qs = new URLSearchParams();
  if (state.activeProjectId) qs.set('projectId', state.activeProjectId);
  qs.set('hideSubmitted', state.hideSubmitted ? '1' : '0');
  const targetsRes = await api(`/targets?${qs.toString()}`);
  state.targets = targetsRes.targets || [];

  const attemptsRes = await api('/attempts');
  state.attempts = attemptsRes.attempts || [];

  renderProjects();
  renderProfiles();
  renderTargets();
  renderDetails();
  renderAttempts();
  renderSettings();
  renderGlobalAllowlist();
  if (state.selectedProfileId) {
    const p = state.profiles.find((x) => x.id === state.selectedProfileId);
    if (p) applyProfileToForm(p);
  }
  await runPrefillPreflight();
  saveUiState();
}

async function loadAttempts() {
  const t = selectedTarget();
  const out = t ? await api(`/targets/${encodeURIComponent(t.id)}/attempts`) : await api('/attempts');
  state.attempts = out.attempts || [];
  renderAttempts();
}

function formatBytes(bytes) {
  const n = Number(bytes || 0);
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function mapProfileForSave(input) {
  const p = input && typeof input === 'object' ? input : {};
  return {
    id: p.id,
    siteName: String(p.siteName ?? p.site_name ?? ''),
    siteUrl: String(p.siteUrl ?? p.site_url ?? ''),
    siteDescriptionShort: String(p.siteDescriptionShort ?? p.site_description_short ?? ''),
    siteDescriptionLong: String(p.siteDescriptionLong ?? p.site_description_long ?? ''),
    contactEmail: String(p.contactEmail ?? p.contact_email ?? ''),
    category: String(p.category ?? ''),
    keywords: String(p.keywords ?? ''),
    country: String(p.country ?? ''),
    rssUrl: String(p.rssUrl ?? p.rss_url ?? ''),
    socialLinks: p.socialLinks && typeof p.socialLinks === 'object' ? p.socialLinks : (p.social_links_json && typeof p.social_links_json === 'object' ? p.social_links_json : {}),
    logoUrl: String(p.logoUrl ?? p.logo_url ?? ''),
  };
}

function normalizeImportPayload(parsed) {
  const obj = parsed && typeof parsed === 'object' ? parsed : null;
  const targetsRaw = Array.isArray(parsed)
    ? parsed
    : Array.isArray(obj?.targets)
      ? obj.targets
      : Array.isArray(obj?.urls)
        ? obj.urls
        : [];

  const targets = [];
  for (const item of targetsRaw) {
    if (typeof item === 'string') {
      const url = item.trim();
      if (url) targets.push({ url });
      continue;
    }
    if (item && typeof item === 'object') {
      const url = String(item.url || '').trim();
      if (!url) continue;
      targets.push({
        url,
        status: item.status ? String(item.status) : undefined,
        type: item.type ? String(item.type) : undefined,
        notes: item.notes != null ? String(item.notes) : undefined,
        tags: Array.isArray(item.tags) ? item.tags.map((x) => String(x || '')).filter(Boolean) : undefined,
      });
    }
  }

  const profilesRaw = Array.isArray(obj?.profiles) ? obj.profiles : [];
  const profiles = profilesRaw
    .filter((x) => x && typeof x === 'object')
    .map((x) => mapProfileForSave(x));

  const settingsRaw = obj?.settings && typeof obj.settings === 'object' ? obj.settings : null;
  const settings = settingsRaw
    ? {
        prefillEnabled: Boolean(settingsRaw.prefillEnabled ?? settingsRaw.prefill_enabled ?? false),
        browserServerId: String(settingsRaw.browserServerId ?? settingsRaw.browser_server_id ?? ''),
        maxPrefillPerDay: Number(settingsRaw.maxPrefillPerDay ?? settingsRaw.max_prefill_per_day ?? 25),
        throttleSeconds: Number(settingsRaw.throttleSeconds ?? settingsRaw.throttle_seconds ?? 15),
        loggingVerbosity: String(settingsRaw.loggingVerbosity ?? settingsRaw.logging_verbosity ?? 'normal'),
        exportPath: String(settingsRaw.exportPath ?? settingsRaw.export_path ?? '.pb/directory-assistant/exports'),
        projectBrowserServerMap: settingsRaw.projectBrowserServerMap && typeof settingsRaw.projectBrowserServerMap === 'object'
          ? settingsRaw.projectBrowserServerMap
          : {},
      }
    : null;

  if (!targets.length && !profiles.length && !settings) {
    throw new Error('JSON import schema invalid. Expected targets[] or profiles[] or settings object.');
  }

  return { targets, profiles, settings };
}

function bind() {
  restoreUiStateIfAny();
  window.addEventListener('beforeunload', saveUiState);
  byId('refreshBtn').onclick = () => loadState().catch((e) => toast(e.message, 'bad'));
  byId('searchInput').oninput = () => { renderTargets(); saveUiState(); };
  byId('statusFilter').onchange = () => { renderTargets(); saveUiState(); };
  const pricingFilter = byId('pricingFilter');
  if (pricingFilter) pricingFilter.onchange = () => { state.pricingFilter = pricingFilter.value || ''; renderTargets(); saveUiState(); };
  const vettedOnly = byId('vettedOnly');
  if (vettedOnly) vettedOnly.onchange = () => { state.vettedOnly = !!vettedOnly.checked; renderTargets(); saveUiState(); };
  const hideSubmitted = byId('hideSubmitted');
  if (hideSubmitted) hideSubmitted.onchange = async () => { state.hideSubmitted = !!hideSubmitted.checked; saveUiState(); await loadState(); };
  const projectSelect = byId('projectSelect');
  if (projectSelect) projectSelect.onchange = async () => {
    state.activeProjectId = projectSelect.value || '';
    saveUiState();
    await api('/projects/select', { method: 'POST', body: JSON.stringify({ projectId: state.activeProjectId }) });
    await loadState();
  };
  byId('profileSelect').onchange = () => {
    state.selectedProfileId = byId('profileSelect').value;
    const p = state.profiles.find((x) => x.id === state.selectedProfileId);
    if (p) applyProfileToForm(p);
    saveUiState();
  };
  const saveProjectBtn = byId('saveProjectBtn');
  if (saveProjectBtn) saveProjectBtn.onclick = async () => {
    const name = String(byId('projectName')?.value || '').trim();
    if (!name) return toast('Project name required', 'warn');
    const primaryDomain = String(byId('projectPrimaryDomain')?.value || '').trim();
    try {
      const out = await api('/projects/save', { method: 'POST', body: JSON.stringify({ project: { name, primaryDomain } }) });
      state.activeProjectId = String(out.currentProjectId || out.id || '');
      if (byId('projectName')) byId('projectName').value = '';
      if (byId('projectPrimaryDomain')) byId('projectPrimaryDomain').value = '';
      await loadState();
      toast('Project saved', 'ok');
    } catch (e) {
      toast(e.message || 'Project save failed', 'bad');
    }
  };

  const browserServerSelect = byId('browserServerSelect');
  if (browserServerSelect) browserServerSelect.onchange = async () => {
    state.selectedBrowserServerId = browserServerSelect.value || '';
    renderPrefillPreflight();
    await runPrefillPreflight();
    saveUiState();
  };
  const prefillConfigureBtn = byId('prefillConfigureBtn');
  if (prefillConfigureBtn) prefillConfigureBtn.onclick = async () => {
    const sid = String(state.selectedBrowserServerId || byId('browserServerSelect')?.value || '');
    if (!sid) return toast('Select a Browser Automation server first', 'warn');
    try {
      const out = await api(`/browser-servers/${encodeURIComponent(sid)}/configure-defaults`, {
        method: 'POST',
        body: JSON.stringify({ projectId: state.activeProjectId }),
      });
      state.selectedBrowserServerId = sid;
      if (state.settings && typeof state.settings === 'object') state.settings.browserServerId = sid;
      toast('Browser server defaults applied.', 'ok');
      if (out?.server) {
        state.browserServers = state.browserServers.map((x) => x.id === sid ? out.server : x);
        renderBrowserServers();
      }
      await runPrefillPreflight();
      await loadState();
    } catch (e) {
      toast(e.message || 'Configure failed', 'bad');
    }
  };

  const mcpBtn = byId('openMcpBtn');
  if (mcpBtn) mcpBtn.onclick = () => window.open('/#/mcp', '_blank', 'noopener,noreferrer');

  byId('addUrlsBtn').onclick = async () => {
    try {
      const urls = byId('bulkUrls').value;
      const out = await api('/targets/bulk-add', { method: 'POST', body: JSON.stringify({ urls, projectId: state.activeProjectId }) });
      byId('bulkUrls').value = '';
      const dup = Array.isArray(out.duplicates) ? out.duplicates : [];
      if (out.added > 0) {
        toast(`Added ${out.added} targets${dup.length ? ` (${dup.length} duplicates skipped)` : ''}`, 'ok');
      } else if (dup.length > 0) {
        toast(`Already exists: ${dup[0].key}`, 'warn');
      } else {
        toast('No valid targets added', 'warn');
      }
      await loadState();
      if (dup.length > 0) {
        const first = dup[0];
        const open = window.confirm(`Already exists: ${first.key}. Open existing target?`);
        if (open && first.existingId) {
          state.selectedId = first.existingId;
          renderTargets();
          renderDetails();
          await loadAttempts();
        }
      }
    } catch (e) { toast(e.message, 'bad'); }
  };

  let importFile = null;
  let importBusy = false;
  const importFileInput = byId('importJsonFile');
  const importBtn = byId('importJsonBtn');
  const importStatus = byId('importJsonStatus');
  let importFeedback = '';
  let importFeedbackTone = 'muted';

  function renderImportState() {
    if (!importBtn || !importStatus) return;
    importBtn.disabled = !importFile || importBusy;
    importBtn.textContent = importBusy ? 'Importing...' : 'Import JSON';
    if (importBusy) {
      importStatus.textContent = importFile ? `Importing ${importFile.name}...` : 'Importing...';
      importStatus.style.color = 'var(--muted)';
      return;
    }
    if (importFeedback) {
      importStatus.textContent = importFeedback;
      importStatus.style.color = importFeedbackTone === 'bad' ? 'var(--bad)' : importFeedbackTone === 'ok' ? 'var(--ok)' : 'var(--muted)';
      return;
    }
    if (!importFile) {
      importStatus.textContent = 'Select a JSON file to import.';
      importStatus.style.color = 'var(--muted)';
      return;
    }
    importStatus.textContent = `Ready: ${importFile.name} (${formatBytes(importFile.size)})`;
    importStatus.style.color = 'var(--muted)';
  }

  if (importFileInput) {
    importFileInput.onchange = () => {
      importFile = importFileInput.files && importFileInput.files[0] ? importFileInput.files[0] : null;
      importFeedback = '';
      importFeedbackTone = 'muted';
      renderImportState();
    };
  }

  byId('importJsonBtn').onclick = async () => {
    if (!importFile || importBusy) return;
    importBusy = true;
    importFeedback = '';
    importFeedbackTone = 'muted';
    renderImportState();
    try {
      const raw = await importFile.text();
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        throw new Error(`Invalid JSON: ${String(e?.message || e)}`);
      }

      const payload = normalizeImportPayload(parsed);
      let addedTargets = 0;
      let savedProfiles = 0;
      let savedSettings = false;

      if (payload.settings) {
        await api('/settings', { method: 'POST', body: JSON.stringify(payload.settings) });
        savedSettings = true;
      }

      for (const profile of payload.profiles) {
        await api('/profiles/save', { method: 'POST', body: JSON.stringify({ profile }) });
        savedProfiles += 1;
      }

      let mergedTargets = 0;
      let duplicateRows = [];
      if (payload.targets.length) {
        const out = await api('/targets/import', { method: 'POST', body: JSON.stringify({ targets: payload.targets, projectId: state.activeProjectId }) });
        addedTargets = Number(out?.added || 0);
        mergedTargets = Number(out?.merged || 0);
        duplicateRows = Array.isArray(out?.duplicates) ? out.duplicates : [];
      }

      toast(`Imported ${addedTargets} new targets${mergedTargets ? `, merged ${mergedTargets}` : ''}${savedProfiles ? `, ${savedProfiles} profiles` : ''}${savedSettings ? ', settings' : ''}`, 'ok');
      importFeedback = `Import complete. Added ${addedTargets} new targets${mergedTargets ? `, merged ${mergedTargets}` : ''}${savedProfiles ? `, ${savedProfiles} profiles` : ''}${savedSettings ? ', settings' : ''}.`;
      importFeedbackTone = 'ok';
      importFile = null;
      if (importFileInput) importFileInput.value = '';
      await loadState();
      if (duplicateRows.length > 0) {
        const first = duplicateRows[0];
        const open = window.confirm(`Already exists: ${first.key}. Open existing target?`);
        if (open && first.existingId) {
          state.selectedId = first.existingId;
          renderTargets();
          renderDetails();
          await loadAttempts();
        }
      }
    } catch (e) {
      importFeedback = String(e?.message || e);
      importFeedbackTone = 'bad';
      toast(String(e?.message || e), 'bad');
    } finally {
      importBusy = false;
      renderImportState();
    }
  };

  renderImportState();

  byId('genQueriesBtn').onclick = async () => {
    try {
      const out = await api('/discover/queries', {
        method: 'POST',
        body: JSON.stringify({
          siteName: byId('p_siteName').value,
          siteUrl: byId('p_siteUrl').value,
          keywords: byId('p_keywords').value,
        }),
      });
      const box = byId('queries');
      box.style.display = 'block';
      box.textContent = (out.queries || []).map((q) => `- ${q}`).join('\n');
    } catch (e) { toast(e.message, 'bad'); }
  };

  byId('saveTargetBtn').onclick = async () => {
    const t = selectedTarget();
    if (!t) return;
    try {
      await api(`/targets/${encodeURIComponent(t.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({
          projectId: state.activeProjectId,
          status: byId('selStatus').value,
          type: byId('selType').value,
          notes: byId('selNotes').value,
          tags: byId('selTags').value.split(',').map((x) => x.trim()).filter(Boolean),
          pricingStatus: byId('selPricingStatus') ? byId('selPricingStatus').value : 'unknown',
          cost: byId('selCost') ? byId('selCost').value : '',
          vetted: byId('selVetted') ? !!byId('selVetted').checked : false,
          projectTags: byId('selProjectTags') ? byId('selProjectTags').value.split(',').map((x) => x.trim()).filter(Boolean) : [],
          lastCheckedAt: new Date().toISOString(),
        }),
      });
      toast('Target saved', 'ok');
      await loadState();
      saveUiState();
    } catch (e) { toast(e.message, 'bad'); }
  };

  byId('openBtn').onclick = () => {
    const t = selectedTarget();
    if (!t) return;
    window.open(t.url, '_blank', 'noopener,noreferrer');
  };

  byId('saveProfileBtn').onclick = async () => {
    try {
      const out = await api('/profiles/save', { method: 'POST', body: JSON.stringify({ profile: readProfileForm() }) });
      state.selectedProfileId = out.id;
      toast('Profile saved', 'ok');
      await loadState();
      saveUiState();
    } catch (e) { toast(e.message, 'bad'); }
  };

  byId('saveSettingsBtn').onclick = async () => {
    try {
      await api('/settings', {
        method: 'POST',
        body: JSON.stringify({
          prefillEnabled: byId('prefillEnabled').checked,
          requireApprovalsForSubmitActions: byId('requireSubmitApprovals') ? !!byId('requireSubmitApprovals').checked : true,
          browserServerId: String(state.selectedBrowserServerId || (byId('browserServerSelect') ? byId('browserServerSelect').value : '')),
          maxPrefillPerDay: Number(byId('maxPrefillPerDay').value || 25),
          throttleSeconds: Number(byId('throttleSeconds').value || 15),
          loggingVerbosity: byId('loggingVerbosity').value,
          exportPath: byId('exportPath').value,
        }),
      });
      toast('Settings saved', 'ok');
      await loadState();
      saveUiState();
    } catch (e) { toast(e.message, 'bad'); }
  };

  byId('allowlistAddBtn').onclick = async () => {
    const input = byId('allowlistAddInput');
    const errEl = byId('allowlistError');
    const domain = String(input.value || '').trim();
    if (!domain) return;
    errEl.textContent = '';
    try {
      const out = await browserApi('/allowlist', {
        method: 'POST',
        body: JSON.stringify({ domain }),
      });
      state.globalAllowlist = out.domains || [];
      input.value = '';
      renderGlobalAllowlist();
      toast('Domain added', 'ok');
    } catch (e) {
      errEl.textContent = e.message || 'Rejected';
    }
  };

  const bulkApplyBtn = byId('bulkApplyBtn');
  if (bulkApplyBtn) bulkApplyBtn.onclick = async () => {
    const targetIds = Array.from(state.selectedTargetIds || []);
    if (!targetIds.length) return toast('Select at least one target', 'warn');
    const patch = {};
    const st = byId('bulkStatus')?.value || '';
    const pr = byId('bulkPricing')?.value || '';
    const vt = byId('bulkVetted')?.value || '';
    const cost = byId('bulkCost')?.value ?? '';
    if (st) patch.status = st;
    if (pr) patch.pricingStatus = pr;
    if (vt === 'true') patch.vetted = true;
    if (vt === 'false') patch.vetted = false;
    if (cost !== '') patch.cost = cost;
    patch.lastCheckedAt = new Date().toISOString();
    const addTags = (byId('bulkAddTags')?.value || '').split(',').map((x) => x.trim()).filter(Boolean);
    const removeTags = (byId('bulkRemoveTags')?.value || '').split(',').map((x) => x.trim()).filter(Boolean);
    try {
      const out = await api('/project-targets/bulk-update', {
        method: 'POST',
        body: JSON.stringify({ projectId: state.activeProjectId, targetIds, patch, addTags, removeTags }),
      });
      toast(`Bulk updated ${out.updated || 0} targets`, 'ok');
      state.selectedTargetIds = new Set();
      if (byId('bulkAddTags')) byId('bulkAddTags').value = '';
      if (byId('bulkRemoveTags')) byId('bulkRemoveTags').value = '';
      await loadState();
    } catch (e) { toast(e.message || 'Bulk update failed', 'bad'); }
  };

  const bulkExportBtn = byId('bulkExportBtn');
  if (bulkExportBtn) bulkExportBtn.onclick = () => {
    const visible = getVisibleTargets();
    const selected = state.selectedTargetIds.size ? visible.filter((x) => state.selectedTargetIds.has(x.id)) : visible;
    const payload = {
      exportedAt: new Date().toISOString(),
      projectId: state.activeProjectId,
      count: selected.length,
      targets: selected.map((t) => ({
        id: t.id,
        url: t.url,
        domain: t.domain,
        projectStatus: t.projectStatus,
        pricingStatus: t.pricingStatus,
        cost: t.cost || null,
        vetted: !!t.vetted,
        lastCheckedAt: t.lastCheckedAt || null,
        projectTags: Array.isArray(t.projectTags) ? t.projectTags : [],
        lastSubmittedAt: t.lastSubmittedAt || null,
        submissionHistory: Array.isArray(t.submissionHistory) ? t.submissionHistory : [],
      })),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `directory-assistant-project-${state.activeProjectId || 'current'}-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  byId('allowlistRestoreBtn').onclick = async () => {
    const errEl = byId('allowlistError');
    errEl.textContent = '';
    try {
      const out = await browserApi('/allowlist', {
        method: 'POST',
        body: JSON.stringify({ domains: [] }),
      });
      state.globalAllowlist = out.domains || [];
      renderGlobalAllowlist();
      toast('Allowlist restored to defaults', 'ok');
    } catch (e) {
      errEl.textContent = e.message || 'Restore failed';
    }
  };

  byId('requestPrefillBtn').onclick = async () => {
    const t = selectedTarget();
    if (!t) return;
    if (!state.selectedProfileId) return toast('Select profile first', 'warn');
    const browserServerId = String(state.selectedBrowserServerId || (byId('browserServerSelect') ? byId('browserServerSelect').value : ''));
    if (!browserServerId) return toast('Select Browser Automation server in Settings', 'warn');
    if (!state.prefillPreflight || state.prefillPreflight.serverId !== browserServerId || !state.prefillPreflight.ready) {
      renderPrefillPreflight();
      return toast('Prefill unavailable until browser server configuration is fixed.', 'warn');
    }
    const sid = sessionId();

    async function attemptPrefill(confirmUnvetted = false) {
      return await api('/prefill/request', {
        method: 'POST',
        body: JSON.stringify({ targetId: t.id, profileId: state.selectedProfileId, browserServerId, sessionId: sid, projectId: state.activeProjectId, confirmUnvetted }),
      });
    }

    try {
      const out = await attemptPrefill(false);
      const review = byId('prefillReview');
      review.style.display = 'block';
      review.textContent = JSON.stringify(out, null, 2);
      toast('Prefill ran (low-risk, no approval).', 'ok');
      saveUiState();
      await loadState();
    } catch (e) {
      const code = String(e?.code || e?.detail?.code || '');
      const domain = String(e?.detail?.domain || t.domain || '');
      if (code === 'VETTED_REQUIRED') {
        toast('This target must be vetted before automation for this project.', 'warn');
        return;
      }
      if (code === 'UNVETTED_CONFIRM_REQUIRED') {
        const go = window.confirm('This site is not vetted for this project. Continue?');
        if (!go) return;
        try {
          const out = await attemptPrefill(true);
          const review = byId('prefillReview');
          review.style.display = 'block';
          review.textContent = JSON.stringify(out, null, 2);
          toast('Prefill ran (unvetted override confirmed).', 'warn');
          saveUiState();
          await loadState();
          return;
        } catch (inner) {
          toast(inner.message || 'Prefill failed', 'bad');
          return;
        }
      }
      if (code === 'BROWSER_PREFILL_CONFIG_MISSING') {
        toast(`Prefill unavailable for server ${String(e?.detail?.serverId || browserServerId || 'unknown')}: missing ${Array.isArray(e?.detail?.missingCapabilities) ? e.detail.missingCapabilities.join(', ') : 'prefill'}.`, 'warn');
        await runPrefillPreflight();
        return;
      }
      if (code === 'DOMAIN_NOT_ALLOWLISTED' || String(e?.message || '').includes('domain_not_allowlisted')) {
        const once = window.confirm('Domain ' + domain + ' is not allowlisted. Approve once for this session?');
        try {
          if (once) {
            await api('/allowlist/approve-once', { method: 'POST', body: JSON.stringify({ domain, sessionId: sid }) });
            const out = await attemptPrefill(false);
            const review = byId('prefillReview');
            review.style.display = 'block';
            review.textContent = JSON.stringify(out, null, 2);
            toast('Prefill ran after one-time domain approval.', 'ok');
            saveUiState();
            await loadState();
            return;
          }
          const perm = window.confirm('Approve ' + domain + ' permanently? This writes to local allowlist.');
          if (perm) {
            await api('/allowlist/approve-permanent', { method: 'POST', body: JSON.stringify({ domain }) });
            const out = await attemptPrefill(false);
            const review = byId('prefillReview');
            review.style.display = 'block';
            review.textContent = JSON.stringify(out, null, 2);
            toast('Prefill ran after permanent domain approval.', 'ok');
            saveUiState();
            await loadState();
            return;
          }
          toast('Domain remains blocked.', 'warn');
          return;
        } catch (inner) {
          toast(inner.message || 'Domain approval failed', 'bad');
          return;
        }
      }
      toast(e.message || 'Prefill failed', 'bad');
    }
  };

  byId('runPrefillBtn').onclick = async () => {
    const t = selectedTarget();
    if (!t) return;
    const notes = byId('submitNote') ? byId('submitNote').value : '';
    try {
      const out = await api('/prefill/run', {
        method: 'POST',
        body: JSON.stringify({
          targetId: t.id,
          projectId: state.activeProjectId,
          profileId: state.selectedProfileId || undefined,
          notes,
          sessionId: sessionId(),
        }),
      });
      if (out.approvalRequired) {
        state.lastApprovalRequestId = String(out.requestId || (out.approvalId ? `apr:${out.approvalId}` : ''));
        toast('Submit approval requested: ' + (state.lastApprovalRequestId || out.approvalId), 'warn');
        const review = byId('prefillReview');
        review.style.display = 'block';
        review.textContent = 'Submit is high-risk and approval-gated. Request: ' + (state.lastApprovalRequestId || ('#' + out.approvalId)) + '\nOpen Approvals to approve.';
      } else {
        toast('Submitted (approval disabled by policy).', 'ok');
      }
      saveUiState();
      await loadState();
    } catch (e) {
      toast(e.message || 'Submit request failed', 'bad');
    }
  };

  byId('markSubmittedBtn').onclick = async () => {
    const t = selectedTarget();
    if (!t) return;
    const notes = byId('submitNote') ? byId('submitNote').value : '';
    const payload = { projectId: state.activeProjectId, notes };
    try {
      await api(`/targets/${encodeURIComponent(t.id)}/mark-submitted`, { method: 'POST', body: JSON.stringify(payload) });
      toast('Marked submitted', 'ok');
      await loadState();
    } catch (e) {
      const code = String(e?.code || e?.detail?.code || '');
      if (code === 'ALREADY_SUBMITTED') {
        const at = String(e?.detail?.lastSubmittedAt || t.lastSubmittedAt || 'unknown date');
        const again = window.confirm(`Already submitted for this project on ${at}. Submit again?`);
        if (!again) return;
        try {
          await api(`/targets/${encodeURIComponent(t.id)}/mark-submitted`, { method: 'POST', body: JSON.stringify({ ...payload, confirmResubmit: true }) });
          toast('Submitted again and history updated', 'ok');
          await loadState();
          return;
        } catch (e2) {
          toast(e2.message || 'Submit failed', 'bad');
          return;
        }
      }
      toast(e.message, 'bad');
    }
  };

  const markSkippedBtn = byId('markSkippedBtn');
  if (markSkippedBtn) markSkippedBtn.onclick = async () => {
    const t = selectedTarget();
    if (!t) return;
    try {
      await api(`/targets/${encodeURIComponent(t.id)}/mark-skipped`, { method: 'POST', body: JSON.stringify({ projectId: state.activeProjectId, notes: byId('submitNote')?.value || '' }) });
      toast('Marked skipped', 'ok');
      await loadState();
    } catch (e) { toast(e.message || 'Skip failed', 'bad'); }
  };

  const resetNewBtn = byId('resetNewBtn');
  if (resetNewBtn) resetNewBtn.onclick = async () => {
    const t = selectedTarget();
    if (!t) return;
    try {
      await api(`/targets/${encodeURIComponent(t.id)}/reset-new`, { method: 'POST', body: JSON.stringify({ projectId: state.activeProjectId }) });
      toast('Reset to new', 'ok');
      await loadState();
    } catch (e) { toast(e.message || 'Reset failed', 'bad'); }
  };

  byId('exportJsonBtn').onclick = () => window.open(`${API_BASE}/export.json`, '_blank', 'noopener,noreferrer');
  byId('exportCsvBtn').onclick = () => window.open(`${API_BASE}/export.csv`, '_blank', 'noopener,noreferrer');
}

bind();
loadState().catch((e) => toast(e.message, 'bad'));
