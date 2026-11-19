/* Bridgeway Tutors — admin console.
 * Pure front-end: every change is a commit to this GitHub repository made
 * through the GitHub REST API with the admin's personal access token.
 * GitHub Pages then serves each student page at  <site>/s/<slug>/
 */
(() => {
  'use strict';

  const API = 'https://api.github.com';
  const STUDENT_DIR = 's';
  const STORE_KEY = 'bw-admin-config';
  const MAX_BYTES = 20 * 1024 * 1024;
  const SITE_BASE = new URL('../', location.href).href; // folder that holds index.html, s/, admin/

  const $ = (sel, el = document) => el.querySelector(sel);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let cfg = null;          // { owner, repo, branch, token }
  let students = [];       // [{ slug, name, createdAt, updatedAt, fileName, size, indexSha, files:[{path,sha}] }]
  const metaCache = new Map(); // blob sha -> parsed meta
  const pending = new Map();   // slug -> { expect, since }
  let busy = false;

  /* ---------------- storage ---------------- */
  const store = {
    get() {
      try { return JSON.parse(localStorage.getItem(STORE_KEY) || sessionStorage.getItem(STORE_KEY) || 'null'); } catch { return null; }
    },
    set(v, remember) {
      try {
        (remember ? localStorage : sessionStorage).setItem(STORE_KEY, JSON.stringify(v));
        (remember ? sessionStorage : localStorage).removeItem(STORE_KEY);
      } catch { /* storage blocked: stay signed in for this tab only */ }
    },
    clear() {
      try { localStorage.removeItem(STORE_KEY); sessionStorage.removeItem(STORE_KEY); } catch { /* ignore */ }
    },
  };

  function detectRepo() {
    const host = location.hostname;
    if (host.endsWith('.github.io')) {
      const owner = host.slice(0, -'.github.io'.length);
      const seg = location.pathname.split('/').filter(Boolean);
      const i = seg.indexOf('admin');
      return { owner, repo: i > 0 ? seg[0] : `${owner}.github.io` };
    }
    return { owner: 'Bridgewaytutors', repo: 'students-portal' };
  }

  /* ---------------- GitHub API ---------------- */
  async function gh(path, opts = {}, token = cfg && cfg.token) {
    const headers = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      Authorization: `Bearer ${token}`,
    };
    if (opts.body) headers['Content-Type'] = 'application/json';
    let res;
    try {
      res = await fetch(API + path, { ...opts, headers, cache: 'no-store' });
    } catch {
      throw new Error('Could not reach GitHub. Check your internet connection.');
    }
    if (!res.ok) {
      let msg = res.statusText;
      try { msg = (await res.json()).message || msg; } catch { /* keep status text */ }
      const err = new Error(friendlyError(res.status, msg));
      err.status = res.status;
      err.raw = msg;
      throw err;
    }
    return res.status === 204 ? null : res.json();
  }

  function friendlyError(status, msg) {
    if (status === 401) return 'GitHub rejected the token. It may be wrong or expired.';
    if (status === 403 && /not accessible/i.test(msg)) return 'This token cannot write to the repository. Give it "Contents: Read and write" permission.';
    if (status === 403 && /rate limit/i.test(msg)) return 'GitHub rate limit reached. Wait a few minutes and try again.';
    if (status === 404) return 'Repository or branch not found, or the token has no access to it.';
    if (status === 409) return 'The repository is empty. Push the portal files to it first.';
    return `GitHub error (${status}): ${msg}`;
  }

  const R = () => `/repos/${cfg.owner}/${cfg.repo}`;

  async function head() {
    const ref = await gh(`${R()}/git/ref/heads/${encodeURI(cfg.branch)}`);
    const commit = await gh(`${R()}/git/commits/${ref.object.sha}`);
    return { commitSha: ref.object.sha, treeSha: commit.tree.sha };
  }

  function decodeB64(b64) {
    const bin = atob(b64.replace(/\s/g, ''));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  async function readBlob(sha) {
    const blob = await gh(`${R()}/git/blobs/${sha}`);
    return decodeB64(blob.content);
  }

  /** One atomic commit. changes: [{path, content}] | [{path, sha}] | [{path, delete:true}] */
  async function commit(changes, message) {
    const entries = await Promise.all(changes.map(async (c) => {
      if (c.delete) return { path: c.path, mode: '100644', type: 'blob', sha: null };
      if (c.sha) return { path: c.path, mode: '100644', type: 'blob', sha: c.sha };
      const blob = await gh(`${R()}/git/blobs`, { method: 'POST', body: JSON.stringify({ content: c.content, encoding: 'utf-8' }) });
      return { path: c.path, mode: '100644', type: 'blob', sha: blob.sha };
    }));
    for (let attempt = 0; ; attempt++) {
      const base = await head();
      const tree = await gh(`${R()}/git/trees`, { method: 'POST', body: JSON.stringify({ base_tree: base.treeSha, tree: entries }) });
      const c = await gh(`${R()}/git/commits`, { method: 'POST', body: JSON.stringify({ message, tree: tree.sha, parents: [base.commitSha] }) });
      try {
        await gh(`${R()}/git/refs/heads/${encodeURI(cfg.branch)}`, { method: 'PATCH', body: JSON.stringify({ sha: c.sha }) });
        return c.sha;
      } catch (e) {
        // Someone else committed in between — rebuild on the new head once or twice.
        if (e.status === 422 && attempt < 2) continue;
        throw e;
      }
    }
  }

  async function pool(items, limit, fn) {
    const out = [];
    let i = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]); }
    });
    await Promise.all(workers);
    return out;
  }

  async function loadStudents() {
    const { treeSha } = await head();
    const tree = await gh(`${R()}/git/trees/${treeSha}?recursive=1`);
    const map = new Map();
    for (const e of tree.tree) {
      if (e.type !== 'blob') continue;
      const m = e.path.match(/^s\/([^/]+)\/(.+)$/);
      if (!m) continue;
      const s = map.get(m[1]) || { slug: m[1], files: [] };
      s.files.push({ path: e.path, sha: e.sha });
      if (m[2] === 'index.html') { s.indexSha = e.sha; s.size = e.size; }
      if (m[2] === 'meta.json') s.metaSha = e.sha;
      map.set(m[1], s);
    }
    const list = [...map.values()].filter((s) => s.indexSha);
    await pool(list.filter((s) => s.metaSha), 8, async (s) => {
      try {
        if (!metaCache.has(s.metaSha)) metaCache.set(s.metaSha, JSON.parse(await readBlob(s.metaSha)));
        const meta = metaCache.get(s.metaSha);
        Object.assign(s, { name: meta.name, createdAt: meta.createdAt, updatedAt: meta.updatedAt, fileName: meta.fileName });
      } catch { /* unreadable meta: fall back to slug */ }
    });
    for (const s of list) s.name = s.name || s.slug;
    list.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')) || a.name.localeCompare(b.name));
    students = list;
  }

  /* ---------------- helpers ---------------- */
  function slugify(name) {
    const base = name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
    return base || 'student';
  }
  function randomId(n = 6) {
    const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
    const bytes = crypto.getRandomValues(new Uint8Array(n));
    return Array.from(bytes, (b) => chars[b % chars.length]).join('');
  }
  function newSlug(name) {
    let slug;
    do { slug = `${slugify(name)}-${randomId()}`; } while (students.some((s) => s.slug === slug));
    return slug;
  }
  const linkFor = (slug) => `${SITE_BASE}${STUDENT_DIR}/${slug}/`;

  function prepareHtml(html) {
    const tag = '<meta name="robots" content="noindex, nofollow">';
    if (/<meta[^>]+name=["']?robots/i.test(html)) return html;
    if (/<head(\s[^>]*)?>/i.test(html)) return html.replace(/<head(\s[^>]*)?>/i, (m) => `${m}\n${tag}`);
    if (/<html(\s[^>]*)?>/i.test(html)) return html.replace(/<html(\s[^>]*)?>/i, (m) => `${m}\n<head>${tag}</head>`);
    return `${tag}\n${html}`;
  }

  const metaJson = (m) => JSON.stringify(m, null, 2) + '\n';

  function fmtDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d)) return '—';
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) + ', ' +
      d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }
  function fmtSize(bytes) {
    if (bytes == null) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  async function readHtmlFile(file) {
    if (!file) throw new Error('Choose an HTML file.');
    if (!/\.html?$/i.test(file.name) && file.type !== 'text/html') throw new Error('That is not an HTML file. Choose a .html file.');
    if (file.size > MAX_BYTES) throw new Error(`That file is ${fmtSize(file.size)}. The limit is ${fmtSize(MAX_BYTES)}.`);
    const text = await file.text();
    if (!text.trim()) throw new Error('That file is empty.');
    return text;
  }

  async function copy(text) {
    try { await navigator.clipboard.writeText(text); }
    catch {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } finally { ta.remove(); }
    }
    toast('Link copied');
  }

  /* ---------------- toasts ---------------- */
  function toast(msg, kind = 'ok') {
    const el = document.createElement('div');
    el.className = `toast toast-${kind}`;
    el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    el.textContent = msg;
    $('#toasts').appendChild(el);
    setTimeout(() => el.classList.add('out'), kind === 'error' ? 6000 : 3000);
    setTimeout(() => el.remove(), kind === 'error' ? 6400 : 3400);
  }

  /* ---------------- modal ---------------- */
  function modal({ title, body = '', confirm = 'Confirm', danger = false, wide = false, cancel = 'Cancel', onConfirm }) {
    return new Promise((resolve) => {
      const dlg = $('#modal');
      dlg.className = 'modal' + (wide ? ' modal-wide' : '');
      dlg.innerHTML = `
        <form method="dialog" class="modal-inner">
          <header class="modal-head"><h2>${esc(title)}</h2>
            <button type="button" class="icon-btn" data-close aria-label="Close">${icon('x')}</button></header>
          <div class="modal-body"></div>
          <p class="modal-error" hidden></p>
          <footer class="modal-foot">
            ${cancel ? `<button type="button" class="btn btn-ghost" data-close>${esc(cancel)}</button>` : ''}
            ${confirm ? `<button type="submit" class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-ok>${esc(confirm)}</button>` : ''}
          </footer>
        </form>`;
      const bodyEl = $('.modal-body', dlg);
      if (typeof body === 'string') bodyEl.innerHTML = body; else bodyEl.appendChild(body);
      const errEl = $('.modal-error', dlg);
      const okBtn = $('[data-ok]', dlg);
      let done = false;
      const finish = (val) => { if (done) return; done = true; dlg.close(); resolve(val); };
      dlg.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => { if (!(okBtn && okBtn.disabled)) finish(null); }));
      dlg.oncancel = (e) => { if (okBtn && okBtn.disabled) e.preventDefault(); else finish(null); };
      $('form', dlg).addEventListener('submit', async (e) => {
        e.preventDefault();
        if (!onConfirm) return finish(true);
        errEl.hidden = true;
        okBtn.disabled = true;
        const label = okBtn.textContent;
        okBtn.innerHTML = `<span class="spinner"></span> Working…`;
        try {
          const val = await onConfirm(dlg);
          finish(val === undefined ? true : val);
        } catch (err) {
          errEl.textContent = err.message;
          errEl.hidden = false;
          okBtn.disabled = false;
          okBtn.textContent = label;
        }
      });
      dlg.showModal();
      const focusEl = $('input', bodyEl) || okBtn;
      if (focusEl) focusEl.focus();
    });
  }

  function previewFrame(html) {
    const f = document.createElement('iframe');
    f.className = 'preview-frame';
    f.title = 'Page preview';
    // Opaque origin: the uploaded page's scripts run but cannot reach this admin page or its token.
    f.setAttribute('sandbox', 'allow-scripts allow-popups allow-forms');
    f.srcdoc = html;
    return f;
  }

  /* ---------------- icons ---------------- */
  const ICONS = {
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h8"/>',
    open: '<path d="M14 4h6v6M20 4l-9 9M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/>',
    more: '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>',
    eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    swap: '<path d="M4 7h13l-3-3M20 17H7l3 3"/>',
    edit: '<path d="M4 20h4L19 9l-4-4L4 16v4z"/><path d="M13 7l4 4"/>',
    link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
    download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
    trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
    refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/>',
    upload: '<path d="M12 16V4M7 9l5-5 5 5M5 20h14"/>',
    file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
  };
  const icon = (n) => `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[n]}</svg>`;

  /* ---------------- views ---------------- */
  function show(view) {
    $('#view-login').hidden = view !== 'login';
    $('#view-app').hidden = view !== 'app';
    $('#topbar-session').hidden = view !== 'app';
  }

  function renderLogin(prefill) {
    const d = { ...detectRepo(), branch: '', ...(prefill || {}) };
    $('#login-owner').value = d.owner || '';
    $('#login-repo').value = d.repo || '';
    $('#login-branch').value = d.branch || '';
    $('#token-link').href = 'https://github.com/settings/personal-access-tokens/new';
    show('login');
    $('#login-token').focus();
  }

  async function onLogin(e) {
    e.preventDefault();
    const btn = $('#login-submit');
    const err = $('#login-error');
    err.hidden = true;
    const next = {
      token: $('#login-token').value.trim(),
      owner: $('#login-owner').value.trim(),
      repo: $('#login-repo').value.trim(),
      branch: $('#login-branch').value.trim(),
    };
    if (!next.token) { err.textContent = 'Paste your GitHub token.'; err.hidden = false; return; }
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Checking…';
    try {
      const repo = await gh(`/repos/${next.owner}/${next.repo}`, {}, next.token);
      if (repo.permissions && repo.permissions.push === false) throw new Error('This GitHub account can view the repository but cannot change it.');
      next.branch = next.branch || repo.default_branch || 'main';
      cfg = next;
      store.set(cfg, $('#login-remember').checked);
      $('#login-token').value = '';
      await enterApp();
    } catch (ex) {
      cfg = null;
      err.textContent = ex.message;
      err.hidden = false;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Sign in';
    }
  }

  async function enterApp() {
    $('#repo-label').textContent = `${cfg.owner}/${cfg.repo} · ${cfg.branch}`;
    $('#repo-label').href = `https://github.com/${cfg.owner}/${cfg.repo}`;
    show('app');
    await refresh();
  }

  async function refresh(quiet = false) {
    const list = $('#student-list');
    if (!quiet) list.innerHTML = `<div class="empty"><span class="spinner"></span> Loading students…</div>`;
    try {
      await loadStudents();
      renderList();
    } catch (e) {
      if (e.status === 401) { signOut(); toast(e.message, 'error'); return; }
      list.innerHTML = `<div class="empty empty-error">${esc(e.message)} <button class="btn btn-ghost btn-sm" id="retry">Try again</button></div>`;
      $('#retry').addEventListener('click', () => refresh());
    }
  }

  function statusBadge(slug) {
    const p = pending.get(slug);
    if (!p) return '';
    if (p.state === 'live') return `<span class="badge badge-live">Live</span>`;
    if (p.state === 'timeout') return `<span class="badge badge-warn" title="GitHub Pages has not served the new version yet. Check the Actions tab of the repository.">Still publishing</span>`;
    return `<span class="badge badge-pending"><span class="spinner spinner-xs"></span> Publishing</span>`;
  }

  function renderList() {
    const q = $('#search').value.trim().toLowerCase();
    const shown = students.filter((s) => !q || s.name.toLowerCase().includes(q) || s.slug.includes(q));
    $('#count').textContent = students.length === 1 ? '1 student' : `${students.length} students`;
    const list = $('#student-list');
    if (!students.length) {
      list.innerHTML = `<div class="empty"><strong>No student pages yet.</strong><br>Add the first one with the form.</div>`;
      return;
    }
    if (!shown.length) {
      list.innerHTML = `<div class="empty">No student matches “${esc(q)}”.</div>`;
      return;
    }
    list.innerHTML = shown.map((s) => `
      <article class="row" data-slug="${esc(s.slug)}">
        <div class="row-main">
          <div class="row-title"><h3>${esc(s.name)}</h3>${statusBadge(s.slug)}</div>
          <a class="row-link" href="${esc(linkFor(s.slug))}" target="_blank" rel="noopener">${esc(linkFor(s.slug).replace(/^https?:\/\//, ''))}</a>
          <p class="row-meta">Updated ${esc(fmtDate(s.updatedAt))}${s.fileName ? ` · ${esc(s.fileName)}` : ''}${s.size != null ? ` · ${esc(fmtSize(s.size))}` : ''}</p>
        </div>
        <div class="row-actions">
          <button class="btn btn-soft btn-sm" data-act="copy">${icon('copy')}<span>Copy link</span></button>
          <button class="btn btn-ghost btn-sm" data-act="replace">${icon('swap')}<span>Replace</span></button>
          <div class="menu">
            <button class="icon-btn" data-act="menu" aria-haspopup="true" aria-expanded="false" aria-label="More actions for ${esc(s.name)}">${icon('more')}</button>
            <div class="menu-pop" role="menu" hidden>
              <button role="menuitem" data-act="open">${icon('open')} Open live page</button>
              <button role="menuitem" data-act="preview">${icon('eye')} Preview file</button>
              <button role="menuitem" data-act="rename">${icon('edit')} Rename student</button>
              <button role="menuitem" data-act="relink">${icon('link')} Generate new link</button>
              <button role="menuitem" data-act="download">${icon('download')} Download HTML</button>
              <hr>
              <button role="menuitem" class="danger" data-act="delete">${icon('trash')} Delete</button>
            </div>
          </div>
        </div>
      </article>`).join('');
  }

  function closeMenus(except) {
    document.querySelectorAll('.menu-pop:not([hidden])').forEach((m) => {
      if (m === except) return;
      m.hidden = true;
      m.previousElementSibling.setAttribute('aria-expanded', 'false');
    });
  }

  /* ---------------- deploy tracking ---------------- */
  let pollTimer = null;
  function track(slug, expect) {
    pending.set(slug, { expect, since: Date.now(), state: 'pending' });
    if (!pollTimer) pollTimer = setInterval(poll, 6000);
  }
  async function poll() {
    let active = 0;
    await Promise.all([...pending.entries()].map(async ([slug, p]) => {
      if (p.state !== 'pending') return;
      try {
        const res = await fetch(`${SITE_BASE}${STUDENT_DIR}/${slug}/meta.json?v=${Date.now()}`, { cache: 'no-store' });
        if (res.ok && (await res.json()).updatedAt === p.expect) {
          p.state = 'live';
          const s = students.find((x) => x.slug === slug);
          toast(`${s ? s.name + '’s' : 'The'} page is live`);
          setTimeout(() => { if (pending.get(slug) === p) { pending.delete(slug); renderList(); } }, 60000);
          return;
        }
      } catch { /* not deployed yet */ }
      if (Date.now() - p.since > 5 * 60 * 1000) p.state = 'timeout';
      else active++;
    }));
    renderList();
    if (!active) { clearInterval(pollTimer); pollTimer = null; }
  }

  /* ---------------- operations ---------------- */
  const find = (slug) => students.find((s) => s.slug === slug);

  async function withLock(fn) {
    if (busy) throw new Error('Another change is still saving. Try again in a moment.');
    busy = true;
    document.body.classList.add('is-busy');
    try { return await fn(); } finally { busy = false; document.body.classList.remove('is-busy'); }
  }

  async function createStudent(name, file) {
    const html = await readHtmlFile(file);
    await loadStudents(); // make sure we see pages added from another device
    const slug = newSlug(name);
    const now = new Date().toISOString();
    const meta = { name, slug, fileName: file.name, createdAt: now, updatedAt: now };
    await commit([
      { path: `${STUDENT_DIR}/${slug}/index.html`, content: prepareHtml(html) },
      { path: `${STUDENT_DIR}/${slug}/meta.json`, content: metaJson(meta) },
    ], `Add page for ${name}`);
    track(slug, now);
    await refresh(true);
    return slug;
  }

  function writeMeta(s, patch) {
    return { name: s.name, slug: s.slug, fileName: s.fileName, createdAt: s.createdAt || s.updatedAt, updatedAt: new Date().toISOString(), ...patch };
  }

  async function act(action, slug, btn) {
    const s = find(slug);
    if (!s) return;
    const link = linkFor(slug);

    if (action === 'copy') return copy(link);
    if (action === 'open') return window.open(link, '_blank', 'noopener');

    if (action === 'preview') {
      const wrap = document.createElement('div');
      wrap.innerHTML = '<div class="empty"><span class="spinner"></span> Loading…</div>';
      const p = modal({ title: `${s.name} — preview`, body: wrap, confirm: '', cancel: 'Close', wide: true });
      try { const html = await readBlob(s.indexSha); wrap.replaceChildren(previewFrame(html)); }
      catch (e) { wrap.innerHTML = `<p class="modal-error">${esc(e.message)}</p>`; }
      return p;
    }

    if (action === 'download') {
      btn && (btn.disabled = true);
      try {
        const html = await readBlob(s.indexSha);
        const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
        const a = Object.assign(document.createElement('a'), { href: url, download: s.fileName || `${s.slug}.html` });
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } catch (e) { toast(e.message, 'error'); }
      finally { btn && (btn.disabled = false); }
      return;
    }

    if (action === 'replace') {
      const input = Object.assign(document.createElement('input'), { type: 'file', accept: '.html,.htm,text/html' });
      input.addEventListener('change', async () => {
        const file = input.files[0];
        if (!file) return;
        let html;
        try { html = await readHtmlFile(file); } catch (e) { toast(e.message, 'error'); return; }
        const body = document.createElement('div');
        body.innerHTML = `<p>Replace <strong>${esc(s.name)}</strong>’s page with <strong>${esc(file.name)}</strong>? The link stays the same.</p>`;
        body.appendChild(previewFrame(html));
        await modal({
          title: 'Replace page', body, confirm: 'Replace page', wide: true,
          onConfirm: () => withLock(async () => {
            const meta = writeMeta(s, { fileName: file.name });
            await commit([
              { path: `${STUDENT_DIR}/${slug}/index.html`, content: prepareHtml(html) },
              { path: `${STUDENT_DIR}/${slug}/meta.json`, content: metaJson(meta) },
            ], `Replace page for ${s.name}`);
            track(slug, meta.updatedAt);
            await refresh(true);
            toast('Page replaced. Publishing…');
          }),
        });
      });
      input.click();
      return;
    }

    if (action === 'rename') {
      await modal({
        title: 'Rename student',
        body: `<label class="field"><span>Student name</span><input id="rename-input" type="text" maxlength="80" required value="${esc(s.name)}"></label>
               <p class="hint">Only the name in this list changes. The link stays the same.</p>`,
        confirm: 'Save name',
        onConfirm: (dlg) => withLock(async () => {
          const name = $('#rename-input', dlg).value.trim();
          if (!name) throw new Error('Enter a name.');
          if (name === s.name) return;
          const meta = writeMeta(s, { name });
          await commit([{ path: `${STUDENT_DIR}/${slug}/meta.json`, content: metaJson(meta) }], `Rename ${s.name} to ${name}`);
          await refresh(true);
          toast('Name saved');
        }),
      });
      return;
    }

    if (action === 'relink') {
      const slug2 = await modal({
        title: 'Generate a new link?',
        body: `<p>${esc(s.name)} gets a new link and the current one stops working within a few minutes. Use this if the link was shared with the wrong person.</p>
               <p class="hint">Current: ${esc(link)}</p>`,
        confirm: 'Generate new link',
        onConfirm: () => withLock(async () => {
          const slug2 = newSlug(s.name);
          const meta = writeMeta(s, { slug: slug2 });
          const changes = [];
          for (const f of s.files) {
            const rest = f.path.slice(`${STUDENT_DIR}/${slug}/`.length);
            if (rest !== 'meta.json') changes.push({ path: `${STUDENT_DIR}/${slug2}/${rest}`, sha: f.sha });
            changes.push({ path: f.path, delete: true });
          }
          changes.push({ path: `${STUDENT_DIR}/${slug2}/meta.json`, content: metaJson(meta) });
          await commit(changes, `New link for ${s.name}`);
          pending.delete(slug);
          track(slug2, meta.updatedAt);
          await refresh(true);
          return slug2;
        }),
      });
      if (slug2) { copy(linkFor(slug2)); toast('New link generated and copied'); }
      return;
    }

    if (action === 'delete') {
      await modal({
        title: `Delete ${s.name}’s page?`,
        body: `<p>The page is removed and its link stops working within a few minutes. This cannot be undone from here.</p>`,
        confirm: 'Delete page', danger: true,
        onConfirm: () => withLock(async () => {
          await commit(s.files.map((f) => ({ path: f.path, delete: true })), `Delete page for ${s.name}`);
          pending.delete(slug);
          await refresh(true);
          toast('Page deleted');
        }),
      });
    }
  }

  /* ---------------- add-student form ---------------- */
  let chosenFile = null;
  function setFile(file) {
    chosenFile = file || null;
    const zone = $('#dropzone');
    const label = $('#file-label');
    const err = $('#add-error');
    err.hidden = true;
    if (!file) {
      zone.classList.remove('has-file');
      label.innerHTML = `<strong>Choose an HTML file</strong><span>or drag it here</span>`;
      $('#preview-btn').hidden = true;
      return;
    }
    zone.classList.add('has-file');
    label.innerHTML = `<strong>${esc(file.name)}</strong><span>${esc(fmtSize(file.size))} · click to change</span>`;
    $('#preview-btn').hidden = false;
    const nameInput = $('#student-name');
    if (!nameInput.value.trim()) {
      nameInput.value = file.name.replace(/\.html?$/i, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim()
        .replace(/\b\w/g, (c) => c.toUpperCase());
    }
  }

  async function onAdd(e) {
    e.preventDefault();
    const err = $('#add-error');
    err.hidden = true;
    const name = $('#student-name').value.trim();
    if (!name) { err.textContent = 'Enter the student’s name.'; err.hidden = false; return; }
    if (!chosenFile) { err.textContent = 'Choose the HTML file for this student.'; err.hidden = false; return; }
    const btn = $('#add-submit');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Publishing…';
    try {
      await withLock(async () => {
        const slug = await createStudent(name, chosenFile);
        $('#add-form').reset();
        setFile(null);
        showResult(name, slug);
      });
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
    } finally {
      btn.disabled = false;
      btn.innerHTML = `${icon('upload')} Publish page`;
    }
  }

  function showResult(name, slug) {
    const link = linkFor(slug);
    const box = $('#add-result');
    box.innerHTML = `
      <p class="result-title">Page created for ${esc(name)}</p>
      <div class="result-link"><input readonly value="${esc(link)}" aria-label="Student link"><button class="btn btn-primary btn-sm" type="button" id="result-copy">${icon('copy')}<span>Copy</span></button></div>
      <p class="hint">Send this link to ${esc(name)}. It goes live in about a minute.</p>`;
    box.hidden = false;
    $('#result-copy').addEventListener('click', () => copy(link));
    $('input', box).addEventListener('focus', (ev) => ev.target.select());
  }

  function signOut() {
    store.clear();
    cfg = null;
    students = [];
    pending.clear();
    $('#add-result').hidden = true;
    renderLogin();
  }

  /* ---------------- wire up ---------------- */
  function init() {
    $('#login-form').addEventListener('submit', onLogin);
    $('#signout').addEventListener('click', signOut);
    $('#refresh').addEventListener('click', () => refresh());
    $('#search').addEventListener('input', renderList);
    $('#add-form').addEventListener('submit', onAdd);

    const fileInput = $('#file-input');
    fileInput.addEventListener('change', () => setFile(fileInput.files[0]));
    const zone = $('#dropzone');
    ['dragenter', 'dragover'].forEach((t) => zone.addEventListener(t, (e) => { e.preventDefault(); zone.classList.add('drag'); }));
    ['dragleave', 'drop'].forEach((t) => zone.addEventListener(t, (e) => { e.preventDefault(); zone.classList.remove('drag'); }));
    zone.addEventListener('drop', (e) => { const f = e.dataTransfer.files[0]; if (f) setFile(f); });

    $('#preview-btn').addEventListener('click', async () => {
      try {
        const html = await readHtmlFile(chosenFile);
        modal({ title: `Preview — ${chosenFile.name}`, body: previewFrame(html), confirm: '', cancel: 'Close', wide: true });
      } catch (e) { toast(e.message, 'error'); }
    });

    $('#student-list').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      const row = btn.closest('.row');
      if (btn.dataset.act === 'menu') {
        const pop = btn.nextElementSibling;
        const open = pop.hidden;
        closeMenus(pop);
        pop.hidden = !open;
        btn.setAttribute('aria-expanded', String(open));
        if (open) pop.querySelector('button').focus();
        return;
      }
      closeMenus();
      act(btn.dataset.act, row.dataset.slug, btn);
    });
    document.addEventListener('click', (e) => { if (!e.target.closest('.menu')) closeMenus(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenus(); });

    const saved = store.get();
    if (saved && saved.token && saved.owner && saved.repo && saved.branch) {
      cfg = saved;
      enterApp();
    } else {
      renderLogin(saved);
    }
  }

  init();
})();
