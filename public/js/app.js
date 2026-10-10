'use strict';
/* MPDO Cemetery Record System - single page application (no frameworks, fully offline) */

const State = {
  token: localStorage.getItem('mpdo_token') || null,
  user: null,
  permissions: {},
  selectedRecord: null,
  selectedPayment: null,
  recordFilters: { search: '', burial_type: '', indigent: '', payment_method: '', status: '', date_from: '', date_to: '', sort: 'control_number', dir: 'desc', page: 1, page_size: 25 },
};

// ---------- tiny DOM helpers ----------
const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
function esc(s) { return Charts.esc(s); }
function el(html) { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstChild; }

function fmtMoney(cents) { return (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function fmtDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${m}/${d}/${y}`;
}
function todayIso() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function uuid() { return crypto.randomUUID ? crypto.randomUUID() : 'ref-' + Date.now() + '-' + Math.random().toString(16).slice(2); }

// ---------- API ----------
async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (State.token) headers['Authorization'] = 'Bearer ' + State.token;
  const res = await fetch(path, { ...opts, headers });
  let data = null;
  try { data = await res.json(); } catch (e) { /* non-JSON (CSV downloads) */ }
  if (res.status === 401 && State.token && !path.startsWith('/api/auth/login')) {
    State.token = null; localStorage.removeItem('mpdo_token');
    showAuth(); throw new Error('Session expired. Please sign in again.');
  }
  if (!res.ok) {
    const err = new Error((data && data.error) || `Request failed (${res.status})`);
    err.status = res.status; err.data = data;
    throw err;
  }
  return data;
}

// ---------- Toast / Modal / Loading ----------
function toast(msg, type = 'success') {
  const root = $('#toast-root');
  const t = el(`<div class="toast toast-${type}">${esc(msg)}</div>`);
  root.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .4s'; setTimeout(() => t.remove(), 400); }, 3800);
}

function showModal({ title, body, footer, size = '', onClose }) {
  const overlay = el(`<div class="modal-overlay">
    <div class="modal ${size === 'sm' ? 'modal-sm' : size === 'lg' ? 'modal-lg' : ''}">
      <div class="modal-head"><h3>${esc(title)}</h3><button class="modal-x" title="Close">&times;</button></div>
      <div class="modal-body"></div>
      <div class="modal-foot"></div>
    </div></div>`);
  const bodyEl = $('.modal-body', overlay);
  if (typeof body === 'string') bodyEl.innerHTML = body; else if (body) bodyEl.appendChild(body);
  const footEl = $('.modal-foot', overlay);
  if (footer) { if (typeof footer === 'string') footEl.innerHTML = footer; else footEl.appendChild(footer); }
  if (!footEl.innerHTML.trim()) footEl.remove();
  const close = () => { overlay.remove(); if (onClose) onClose(); };
  $('.modal-x', overlay).onclick = close;
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', function escHandler(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', escHandler); }
  });
  $('#modal-root').appendChild(overlay);
  return { overlay, close, bodyEl, footEl };
}

function confirmDialog(message, { danger = false, title = 'Confirm Action', extra = '' } = {}) {
  return new Promise((resolve) => {
    const m = showModal({
      title, size: 'sm',
      body: `<p style="margin:0 0 6px">${esc(message)}</p>${extra}`,
      footer: `<button class="btn" data-act="cancel">Cancel</button>
               <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-act="ok">${danger ? 'Yes, Continue' : 'Confirm'}</button>`,
    });
    $('[data-act="cancel"]', m.overlay).onclick = () => { m.close(); resolve(false); };
    $('[data-act="ok"]', m.overlay).onclick = () => { m.close(); resolve(true); };
  });
}

function loading(show, text) {
  const ov = $('#loading-overlay');
  if (show) { $('#loading-text').textContent = text || 'Working…'; ov.classList.remove('hidden'); }
  else ov.classList.add('hidden');
}

// Display field-level errors from API into a form container
function showFieldErrors(container, errors) {
  $$('.field', container).forEach(f => f.classList.remove('has-error'));
  if (!errors) return;
  for (const [field, msg] of Object.entries(errors)) {
    const f = container.querySelector(`[data-field="${field}"]`) || container.querySelector(`#${field}`);
    if (f) {
      const wrap = f.closest('.field') || f.closest('label');
      if (wrap) { wrap.classList.add('has-error'); let e = $('.field-error', wrap); if (!e) { e = el('<div class="field-error"></div>'); wrap.appendChild(e); } e.textContent = msg; }
    } else toast(msg, 'error');
  }
}

// ---------- Router ----------
const Pages = {}; // filled by page modules
function navigate(page) { location.hash = '#' + page; }
window.addEventListener('hashchange', () => route());
function route() {
  if (!State.user) return;
  const page = (location.hash || '#dashboard').slice(1).split('/')[0];
  const def = Pages[page] || Pages.dashboard;
  $$('.nav-item').forEach(a => a.classList.toggle('active', a.dataset.page === page));
  $('#page-title').textContent = def.title || page;
  $('#topbar-actions').innerHTML = '';
  $('#content').innerHTML = '<p class="muted">Loading…</p>';
  try { def.render($('#content')); } catch (e) { console.error(e); $('#content').innerHTML = `<div class="error-box">${esc(e.message)}</div>`; }
}

function can(perm) { return !!State.permissions[perm]; }

// Null-safe event binding: role-restricted buttons may not be rendered
function on(target, event, fn) {
  const elx = typeof target === 'string' ? $(target) : target;
  if (elx) elx.addEventListener(event, fn);
  return elx;
}

// ---------- Auth ----------
function showAuth() {
  $('#app-view').classList.add('hidden');
  $('#auth-view').classList.remove('hidden');
  loading(false);
}
function showApp() {
  $('#auth-view').classList.add('hidden');
  $('#app-view').classList.remove('hidden');
  $('#user-name').textContent = State.user.fullName;
  $('#user-role').textContent = State.user.role;
  $('#user-avatar').textContent = (State.user.fullName || '?').trim().charAt(0).toUpperCase();
  $$('.admin-only').forEach(e => e.classList.toggle('hidden', State.user.role !== 'Administrator'));
  route();
}

async function initAuth() {
  try {
    const s = await api('/api/setup/status');
    if (s.needsSetup) { $('#auth-view').classList.remove('hidden'); $('#setup-form').classList.remove('hidden'); return; }
  } catch (e) { $('#auth-view').classList.remove('hidden'); $('#auth-msg').textContent = 'Cannot reach local server: ' + e.message; return; }
  if (State.token) {
    try {
      const me = await api('/api/auth/me');
      State.user = me.user; State.permissions = me.permissions;
      showApp(); return;
    } catch (e) { /* fall through to login */ }
  }
  $('#auth-view').classList.remove('hidden');
  $('#login-form').classList.remove('hidden');
}

$('#toggle-pw').addEventListener('click', () => {
  const inp = $('#login-password');
  const show = inp.type === 'password';
  inp.type = show ? 'text' : 'password';
  $('#toggle-pw').textContent = show ? 'Hide' : 'Show';
});

$('#setup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('#auth-msg'); msg.textContent = '';
  const pw = $('#setup-password').value, pw2 = $('#setup-password2').value;
  if (pw !== pw2) { msg.textContent = 'Passwords do not match.'; return; }
  try {
    loading(true, 'Creating administrator…');
    await api('/api/setup/admin', { method: 'POST', body: JSON.stringify({ full_name: $('#setup-fullname').value, username: $('#setup-username').value, password: pw }) });
    loading(false);
    msg.style.color = 'var(--ok)'; msg.textContent = 'Administrator created. Please sign in.';
    $('#setup-form').classList.add('hidden');
    $('#login-form').classList.remove('hidden');
  } catch (err) { loading(false); msg.style.color = 'var(--err)'; msg.textContent = err.message; }
});

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('#auth-msg'); msg.textContent = '';
  try {
    loading(true, 'Signing in…');
    const d = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: $('#login-username').value, password: $('#login-password').value }) });
    State.token = d.token; State.user = d.user;
    localStorage.setItem('mpdo_token', d.token);
    const me = await api('/api/auth/me');
    State.permissions = me.permissions;
    loading(false);
    $('#login-password').value = '';
    showApp();
  } catch (err) { loading(false); msg.style.color = 'var(--err)'; msg.textContent = err.message; }
});

$('#btn-logout').addEventListener('click', async () => {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch (e) { /* ignore */ }
  State.token = null; State.user = null;
  localStorage.removeItem('mpdo_token');
  showAuth();
  $('#login-form').classList.remove('hidden');
});

initAuth();

// ======================= DASHBOARD =======================
Pages.dashboard = {
  title: 'Dashboard',
  async render(root) {
    root.innerHTML = '<p class="muted">Loading dashboard…</p>';
    let d;
    try { d = await api('/api/dashboard'); } catch (e) { root.innerHTML = `<div class="error-box">${esc(e.message)}</div>`; return; }
    const c = d.cards;
    root.innerHTML = `
      <div class="cards-grid">
        <div class="stat-card"><div class="stat-label">Total Cemetery Records</div><div class="stat-value">${c.total_records}</div></div>
        <div class="stat-card accent-gold"><div class="stat-label">Indigent Records</div><div class="stat-value">${c.indigent_records}</div></div>
        <div class="stat-card"><div class="stat-label">Non-Indigent Records</div><div class="stat-value">${c.non_indigent_records}</div></div>
        <div class="stat-card accent-blue"><div class="stat-label">Installment Accounts</div><div class="stat-value">${c.installment_accounts}</div></div>
        <div class="stat-card accent-blue"><div class="stat-label">Full Payment Accounts</div><div class="stat-value">${c.full_payment_accounts}</div></div>
        <div class="stat-card"><div class="stat-label">Total Amount Due</div><div class="stat-value">${fmtMoney(c.total_due_cents)}</div></div>
        <div class="stat-card accent-green"><div class="stat-label">Total Amount Collected</div><div class="stat-value">${fmtMoney(c.total_collected_cents)}</div></div>
        <div class="stat-card accent-red"><div class="stat-label">Outstanding Balance</div><div class="stat-value">${fmtMoney(c.outstanding_cents)}</div></div>
        <div class="stat-card accent-green"><div class="stat-label">Payments Received Today</div><div class="stat-value">${c.payments_today_count}</div><div class="muted" style="font-size:12px">${fmtMoney(Math.round(parseFloat(c.payments_today_amount) * 100))}</div></div>
      </div>
      <div class="charts-grid">
        <div class="chart-box"><h4>Records by Burial Type</h4><div id="ch-burial"></div></div>
        <div class="chart-box"><h4>Payment Collection by Month</h4><div id="ch-monthly"></div></div>
        <div class="chart-box"><h4>Paid vs Partial vs Unpaid</h4><div id="ch-status"></div></div>
      </div>
      <p class="muted" style="margin-top:14px;font-size:12px">All figures are calculated live from the local SQLite database.</p>`;
    Charts.hbar($('#ch-burial'), d.charts.by_burial_type);
    Charts.vbar($('#ch-monthly'), d.charts.monthly_collections.map(m => ({ label: m.label, value: m.value })), { compact: true });
    Charts.donut($('#ch-status'), d.charts.by_status);
  },
};

// ======================= CEMETERY RECORDS =======================
const BURIAL_TYPES = ['Apartment 1st Floor', 'Apartment 2nd Floor', 'Apartment 3rd Floor', 'Lot/Raised Vault', 'Ground/Buried Vault', 'Museleo'];
const PAYMENT_PRICES = {
  'Apartment 1st Floor': { Installment: 2500000, 'Full Payment (Cash)': 2000000 },
  'Apartment 2nd Floor': { Installment: 2500000, 'Full Payment (Cash)': 2000000 },
  'Apartment 3rd Floor': { Installment: 2500000, 'Full Payment (Cash)': 2000000 },
  'Lot/Raised Vault': { Installment: 3000000, 'Full Payment (Cash)': 2000000 },
  'Ground/Buried Vault': { Installment: 3000000, 'Full Payment (Cash)': 2000000 },
  'Museleo': { Installment: 7000000, 'Full Payment (Cash)': 6000000 },
};
let PRICING = { ...PAYMENT_PRICES };

Pages.records = {
  title: 'Cemetery Records',
  async render(root) {
    // load current pricing for instant client-side calculation
    try { const s = await api('/api/settings'); PRICING = { ...PAYMENT_PRICES, ...s.pricing }; } catch (e) { /* keep defaults */ }
    root.innerHTML = `
      <div class="panel">
        <div class="panel-head">
          <div class="toolbar">
            <input type="search" id="rec-search" placeholder="Search control #, name, relative, OR #…" value="${esc(State.recordFilters.search)}">
            <select id="f-burial"><option value="">All Burial Types</option>${BURIAL_TYPES.map(t => `<option ${State.recordFilters.burial_type === t ? 'selected' : ''}>${t}</option>`).join('')}</select>
            <select id="f-indigent"><option value="">Indigent: All</option><option ${State.recordFilters.indigent === 'Yes' ? 'selected' : ''}>Yes</option><option ${State.recordFilters.indigent === 'No' ? 'selected' : ''}>No</option></select>
            <select id="f-pm"><option value="">Payment Method: All</option><option ${State.recordFilters.payment_method === 'Installment' ? 'selected' : ''}>Installment</option><option ${State.recordFilters.payment_method === 'Full Payment (Cash)' ? 'selected' : ''}>Full Payment (Cash)</option><option ${State.recordFilters.payment_method === 'N/A' ? 'selected' : ''}>N/A</option></select>
            <select id="f-status"><option value="">Status: All</option><option ${State.recordFilters.status === 'Paid' ? 'selected' : ''}>Paid</option><option ${State.recordFilters.status === 'Partial' ? 'selected' : ''}>Partial</option><option ${State.recordFilters.status === 'Unpaid' ? 'selected' : ''}>Unpaid</option><option ${State.recordFilters.status === 'Indigent' ? 'selected' : ''}>Indigent</option></select>
            <label class="muted" style="font-size:12px">Burial from <input type="date" id="f-from" value="${State.recordFilters.date_from}"></label>
            <label class="muted" style="font-size:12px">to <input type="date" id="f-to" value="${State.recordFilters.date_to}"></label>
            <button class="btn btn-sm" id="btn-filter">Apply</button>
            <button class="btn btn-sm" id="btn-clear">Clear</button>
          </div>
          <div class="toolbar">
            <button class="btn btn-sm" id="btn-refresh">⟳ Refresh</button>
            ${can('export:csv') ? '<button class="btn btn-sm" id="btn-export-csv">⤓ Export CSV</button>' : ''}
            <button class="btn btn-sm" id="btn-print-list">🖨 Print</button>
            ${can('records:create') ? '<button class="btn btn-primary btn-sm" id="btn-new">＋ New Record</button>' : ''}
          </div>
        </div>
        <div class="panel-body" style="padding:0">
          <div class="table-wrap"><table class="grid" id="rec-table">
            <thead><tr>
              <th class="sortable" data-sort="control_number">Control №</th>
              <th class="sortable" data-sort="deceased_name">Deceased Name</th>
              <th>Date of Death</th><th>Date of Burial</th>
              <th class="sortable" data-sort="indigent">Indigent</th>
              <th class="sortable" data-sort="burial_type">Burial Type</th>
              <th>Payment Method</th>
              <th class="sortable num" data-sort="total">Total Amount</th>
              <th class="sortable num" data-sort="balance">Balance</th>
              <th class="sortable">Latest Date Process</th><th>Latest Remarks</th>
              <th class="no-print">Actions</th>
            </tr></thead>
            <tbody id="rec-tbody"><tr><td colspan="12" class="muted">Loading…</td></tr></tbody>
          </table></div>
          <div class="pager" id="rec-pager"></div>
        </div>
      </div>
      <div id="payment-panel"></div>`;
    on('#btn-new', 'click', () => RecordsUI.openForm(null));
    $('#btn-refresh').addEventListener('click', () => RecordsUI.load());
    $('#btn-filter').addEventListener('click', () => RecordsUI.applyFilters());
    $('#btn-clear').addEventListener('click', () => {
      State.recordFilters = { ...State.recordFilters, search: '', burial_type: '', indigent: '', payment_method: '', status: '', date_from: '', date_to: '', page: 1 };
      this.render(root);
    });
    $('#rec-search').addEventListener('keydown', (e) => { if (e.key === 'Enter') RecordsUI.applyFilters(); });
    $$('#rec-table th.sortable').forEach(th => th.addEventListener('click', () => {
      const s = th.dataset.sort;
      if (State.recordFilters.sort === s) State.recordFilters.dir = State.recordFilters.dir === 'asc' ? 'desc' : 'asc';
      else { State.recordFilters.sort = s; State.recordFilters.dir = 'asc'; }
      State.recordFilters.page = 1;
      RecordsUI.load();
    }));
    on('#btn-export-csv', 'click', () => RecordsUI.exportCsv());
    $('#btn-print-list').addEventListener('click', () => RecordsUI.printList());
    await RecordsUI.load();
  },
};

const RecordsUI = {
  async filtersQueryString() {
    const f = State.recordFilters;
    return new URLSearchParams(Object.entries(f).filter(([, v]) => v !== '' && v != null)).toString();
  },
  applyFilters() {
    State.recordFilters.search = $('#rec-search').value.trim();
    State.recordFilters.burial_type = $('#f-burial').value;
    State.recordFilters.indigent = $('#f-indigent').value;
    State.recordFilters.payment_method = $('#f-pm').value;
    State.recordFilters.status = $('#f-status').value;
    State.recordFilters.date_from = $('#f-from').value;
    State.recordFilters.date_to = $('#f-to').value;
    State.recordFilters.page = 1;
    this.load();
  },
  async load() {
    const tbody = $('#rec-tbody');
    try {
      const d = await api('/api/records?' + await this.filtersQueryString());
      if (!d.records.length) { tbody.innerHTML = '<tr><td colspan="12" class="muted" style="text-align:center;padding:24px">No cemetery records found.</td></tr>'; }
      else {
        tbody.innerHTML = d.records.map(r => `
          <tr data-id="${r.record_id}" data-cn="${esc(r.control_number)}" class="${State.selectedRecord && State.selectedRecord.record_id === r.record_id ? 'selected' : ''}">
            <td><b>${esc(r.control_number)}</b></td>
            <td class="wrap-text">${esc(r.deceased_name)}</td>
            <td>${fmtDate(r.date_of_death)}</td>
            <td>${fmtDate(r.date_of_burial)}</td>
            <td>${r.indigent}</td>
            <td>${esc(r.burial_type)}</td>
            <td>${esc(r.payment_method)}</td>
            <td class="num">${fmtMoney(r.total_cents)}</td>
            <td class="num ${r.balance_cents > 0 ? 'balance-due' : 'balance-zero'}">${fmtMoney(r.balance_cents)}<br><span class="tag tag-${r.status.toLowerCase()}">${r.status}</span></td>
            <td>${fmtDate(r.latest_date_process) || '<span class="muted">N/A</span>'}</td>
            <td class="wrap-text">${esc(r.latest_remarks) || '<span class="muted">N/A</span>'}</td>
            <td class="no-print" style="white-space:nowrap">
              <button class="btn btn-sm" data-act="view">Payments</button>
              ${can('records:update') ? '<button class="btn btn-sm" data-act="edit">Edit</button>' : ''}
              ${can('records:delete') ? '<button class="btn btn-sm btn-danger" data-act="del">Delete</button>' : ''}
            </td>
          </tr>`).join('');
      }
      $('#rec-pager').innerHTML = `
        <span>${d.total} record(s)</span>
        <button class="btn btn-sm" ${d.page <= 1 ? 'disabled' : ''} data-pg="${d.page - 1}">‹ Prev</button>
        <span>Page ${d.page} of ${d.pages}</span>
        <button class="btn btn-sm" ${d.page >= d.pages ? 'disabled' : ''} data-pg="${d.page + 1}">Next ›</button>`;
      $$('#rec-pager [data-pg]').forEach(b => b.addEventListener('click', () => { State.recordFilters.page = parseInt(b.dataset.pg, 10); this.load(); }));
      $$('#rec-tbody tr[data-id]').forEach(tr => {
        tr.addEventListener('click', (e) => {
          if (e.target.closest('button')) return;
          this.selectRow(tr);
        });
        const act = (sel, fn) => { const b = tr.querySelector(sel); if (b) b.addEventListener('click', () => fn(tr)); };
        act('[data-act="view"]', (t) => this.selectRow(t));
        act('[data-act="edit"]', (t) => this.openForm({ record_id: parseInt(t.dataset.id, 10), control_number: t.dataset.cn }));
        act('[data-act="del"]', (t) => this.deleteRecord(parseInt(t.dataset.id, 10), t.dataset.cn));
      });
    } catch (e) { tbody.innerHTML = `<tr><td colspan="12"><div class="error-box">${esc(e.message)}</div></td></tr>`; }
  },
  async selectRow(tr) {
    $$('#rec-tbody tr').forEach(x => x.classList.remove('selected'));
    tr.classList.add('selected');
    const cn = tr.dataset.cn;
    loading(true, 'Loading payment history…');
    try {
      const h = await api('/api/payments/history/' + encodeURIComponent(cn));
      State.selectedRecord = h.record;
      renderPaymentPanel(h);
    } catch (e) { toast(e.message, 'error'); }
    loading(false);
  },
  async deleteRecord(id, cn) {
    if (!can('records:delete')) return toast('Only administrators can delete records.', 'error');
    let extra = '';
    try {
      const r = await api('/api/records?' + new URLSearchParams({ page_size: 1, search: cn }));
      // fetch details via history for payment count
      const h = await api('/api/payments/history/' + encodeURIComponent(cn));
      if (h.payments.length) {
        const ok = await confirmDialog(
          `Record ${cn} has ${h.payments.length} payment transaction(s) totaling ${h.summary.paid}.`,
          { danger: true, title: 'Delete Record With Payment History', extra: `
            <label style="display:block;margin:10px 0"><input type="radio" name="delpol" value="block" checked> Keep payment history — do not delete (cancel)</label>
            <label style="display:block;margin:6px 0"><input type="radio" name="delpol" value="all"> Delete record AND all ${h.payments.length} payment transactions permanently</label>` });
        if (!ok) return;
        const pol = ($('input[name="delpol"]:checked') || {}).value;
        if (pol !== 'all') return toast('Deletion cancelled. Payment history requires the explicit "delete all" policy.', 'info');
        loading(true, 'Deleting…');
        await api('/api/records/' + id, { method: 'DELETE', body: JSON.stringify({ delete_payments: true }) });
        loading(false);
        toast(`Record ${cn} and its payments deleted.`);
        State.selectedRecord = null;
        $('#payment-panel').innerHTML = '';
        this.load();
        return;
      }
    } catch (e) { /* fall through to simple confirm */ }
    const ok = await confirmDialog(`Delete cemetery record ${cn}? This cannot be undone.`, { danger: true });
    if (!ok) return;
    try {
      loading(true, 'Deleting…');
      await api('/api/records/' + id, { method: 'DELETE', body: JSON.stringify({ confirm: true }) });
      loading(false);
      toast(`Record ${cn} deleted.`);
      State.selectedRecord = null;
      $('#payment-panel').innerHTML = '';
      this.load();
    } catch (e) { loading(false); toast(e.message, 'error'); }
  },
  async exportCsv() {
    const scopeAll = await confirmDialog('Export ALL records, or only records matching the current search/filters?', {
      title: 'Export Cemetery Records',
      extra: '<p class="muted" style="font-size:12.5px">OK = all records &nbsp;|&nbsp; Cancel = current filtered results only</p>',
    });
    try {
      loading(true, 'Exporting…');
      const params = new URLSearchParams({ scope: scopeAll ? 'all' : 'filtered' });
      if (!scopeAll) for (const [k, v] of Object.entries(State.recordFilters)) if (v) params.set(k, v);
      const res = await fetch('/api/export/csv/records?' + params, { headers: { Authorization: 'Bearer ' + State.token } });
      if (!res.ok) throw new Error('Export failed');
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `mpdo_cemetery_records_${todayIso()}.csv`;
      a.click(); URL.revokeObjectURL(a.href);
      loading(false);
      toast(scopeAll ? 'All cemetery records exported.' : 'Filtered cemetery records exported.');
    } catch (e) { loading(false); toast(e.message, 'error'); }
  },
  async printList() {
    const d = await api('/api/records?' + await this.filtersQueryString() + '&page_size=200');
    printReport('Complete Cemetery Records', `
      <table class="grid"><thead><tr><th>Control №</th><th>Deceased Name</th><th>Death</th><th>Burial</th><th>Ind.</th><th>Burial Type</th><th>Method</th><th class="num">Total</th><th class="num">Paid</th><th class="num">Balance</th></tr></thead>
      <tbody>${d.records.map(r => `<tr><td>${esc(r.control_number)}</td><td>${esc(r.deceased_name)}</td><td>${fmtDate(r.date_of_death)}</td><td>${fmtDate(r.date_of_burial)}</td><td>${r.indigent}</td><td>${esc(r.burial_type)}</td><td>${esc(r.payment_method)}</td><td class="num">${fmtMoney(r.total_cents)}</td><td class="num">${fmtMoney(r.paid_cents)}</td><td class="num">${fmtMoney(r.balance_cents)}</td></tr>`).join('')}</tbody></table>`);
  },
};

// ---------- Record form (New / Edit) ----------
RecordsUI.openForm = async function (existing) {
  let record = existing;
  if (existing && existing.record_id) {
    const d = await api('/api/records?' + new URLSearchParams({ search: existing.control_number, page_size: 5 }));
    record = d.records.find(r => r.control_number === existing.control_number) || existing;
  }
  let nextCn = '';
  if (!existing) { try { nextCn = (await api('/api/records/next-control-number')).control_number; } catch (e) { nextCn = '(auto)'; } }
  const isEdit = !!record;
  const m = showModal({
    title: isEdit ? `Edit Record — ${record.control_number}` : 'New Cemetery Record',
    body: `
      <div class="form-grid" id="rec-form">
        <div class="field"><label>Control Number</label><input class="ro" id="rf-cn" value="${esc(isEdit ? record.control_number : nextCn)}" readonly></div>
        <div class="field"><label class="req">Deceased Name</label><input id="rf-name" data-field="deceased_name" value="${esc(record ? record.deceased_name : '')}" maxlength="150" autocomplete="off"><div class="field-error"></div></div>
        <div class="field"><label>Date of Death</label><input type="date" id="rf-dod" data-field="date_of_death" value="${record ? record.date_of_death || '' : ''}"><div class="field-error"></div></div>
        <div class="field"><label>Date of Burial</label><input type="date" id="rf-dob" data-field="date_of_burial" value="${record ? record.date_of_burial || '' : ''}"><div class="field-error"></div></div>
        <div class="field"><label class="req">Burial Type</label><select id="rf-burial" data-field="burial_type">${BURIAL_TYPES.map(t => `<option ${record && record.burial_type === t ? 'selected' : ''}>${t}</option>`).join('')}</select><div class="field-error"></div></div>
        <div class="field"><label class="req">Indigent</label><select id="rf-indigent" data-field="indigent"><option value="No" ${record && record.indigent === 'No' ? 'selected' : ''}>No</option><option value="Yes" ${record && record.indigent === 'Yes' ? 'selected' : ''}>Yes</option></select><div class="field-error"></div></div>
        <div class="field"><label class="req">Payment Method</label><select id="rf-pm" data-field="payment_method">
          <option value="Installment" ${record && record.payment_method === 'Installment' ? 'selected' : ''}>Installment</option>
          <option value="Full Payment (Cash)" ${record && record.payment_method === 'Full Payment (Cash)' ? 'selected' : ''}>Full Payment (Cash)</option>
          <option value="N/A" ${record && record.payment_method === 'N/A' ? 'selected' : ''}>N/A</option>
        </select><div class="field-error"></div></div>
        <div class="field"><label>Total Amount (auto)</label><input class="ro" id="rf-total" readonly><small>Calculated from burial type, indigent status and payment method.</small></div>
        <div class="field"><label>Balance</label><input class="ro" id="rf-balance" readonly><small>Balance = Total Amount − payments recorded.</small></div>
      </div>
      <div id="rf-note"></div>`,
    footer: `<button class="btn" id="rf-cancel">Cancel</button>
             <button class="btn btn-primary" id="rf-save">${isEdit ? 'Update Record' : 'Save Record'}</button>`,
  });
  const form = $('#rec-form', m.overlay);
  const recalc = () => {
    const indigent = $('#rf-indigent').value;
    const bt = $('#rf-burial').value;
    const pmSel = $('#rf-pm');
    if (indigent === 'Yes') { pmSel.value = 'N/A'; pmSel.disabled = true; }
    else { pmSel.disabled = false; if (pmSel.value === 'N/A') pmSel.value = 'Installment'; }
    const total = indigent === 'Yes' ? 0 : ((PRICING[bt] || {})[pmSel.value] || 0);
    $('#rf-total').value = fmtMoney(total);
    const paid = record && record.paid_cents != null ? record.paid_cents : 0;
    const bal = Math.max(0, total - paid);
    $('#rf-balance').value = fmtMoney(bal);
  };
  $('#rf-indigent').addEventListener('change', recalc);
  $('#rf-burial').addEventListener('change', recalc);
  $('#rf-pm').addEventListener('change', recalc);
  recalc();
  $('#rf-cancel').onclick = () => m.close();
  $('#rf-save').onclick = async () => {
    const payload = {
      deceased_name: $('#rf-name').value,
      date_of_death: $('#rf-dod').value || null,
      date_of_burial: $('#rf-dob').value || null,
      burial_type: $('#rf-burial').value,
      indigent: $('#rf-indigent').value,
      payment_method: $('#rf-pm').value,
    };
    if (isEdit) {
      const changedPricing = record.burial_type !== payload.burial_type || record.indigent !== payload.indigent || record.payment_method !== payload.payment_method;
      const newTotal = payload.indigent === 'Yes' ? 0 : ((PRICING[payload.burial_type] || {})[payload.payment_method] || 0);
      if (changedPricing && newTotal !== record.total_cents) {
        const applyNew = await confirmDialog(
          `Pricing changed. Apply the new standard Total Amount of ${fmtMoney(newTotal)}? (Stored total was ${fmtMoney(record.total_cents)}.)`,
          { title: 'Recalculate Total Amount', extra: '<p class="muted" style="font-size:12.5px">OK = use new standard price &nbsp;|&nbsp; Cancel = keep stored Total Amount</p>' });
        payload.recalculate = applyNew;
        if (!applyNew) payload.total_cents = record.total_cents;
      }
    }
    try {
      loading(true, isEdit ? 'Updating…' : 'Saving…');
      const d = isEdit
        ? await api('/api/records/' + record.record_id, { method: 'PUT', body: JSON.stringify(payload) })
        : await api('/api/records', { method: 'POST', body: JSON.stringify(payload) });
      loading(false);
      toast(isEdit ? `Record ${d.record.control_number} updated.` : `Record ${d.record.control_number} created.`);
      m.close();
      RecordsUI.load();
    } catch (e) {
      loading(false);
      if (e.data && e.data.needsConfirmation) {
        const ok = await confirmDialog(e.data.message, { title: 'Confirm Indigent Change', danger: true });
        if (ok) { payload.confirm_indigent = true; $('#rf-save').click2 = true; try { loading(true); const d2 = await api('/api/records/' + record.record_id, { method: 'PUT', body: JSON.stringify(payload) }); loading(false); toast(`Record ${d2.record.control_number} updated.`); m.close(); RecordsUI.load(); } catch (e2) { loading(false); toast(e2.message, 'error'); } }
      } else showFieldErrors(form, e.data && e.data.errors);
      if (!(e.data && e.data.needsConfirmation) && !(e.data && e.data.errors)) toast(e.message, 'error');
    }
  };
};

// ---------- Payment history panel ----------
function renderPaymentPanel(h) {
  const r = h.record;
  const panel = $('#payment-panel');
  panel.innerHTML = `
    <div class="panel">
      <div class="panel-head">
        <h3>Payment History — <b>${esc(r.control_number)}</b> · ${esc(r.deceased_name)} <span class="tag tag-${r.status}">${r.status}</span></h3>
        <div class="toolbar">
          ${can('payments:create') ? '<button class="btn btn-primary btn-sm" id="pay-add">＋ Add New Payment</button>' : ''}
          <button class="btn btn-sm" id="pay-edit" disabled>Edit Selected Payment</button>
          ${can('payments:delete') ? '<button class="btn btn-sm btn-danger" id="pay-del" disabled>Delete Selected Payment</button>' : ''}
          <button class="btn btn-sm" id="pay-print-one" disabled>Print Payment Details</button>
          <button class="btn btn-sm" id="pay-print-hist">🖨 Print Payment History</button>
          ${can('export:csv') ? '<button class="btn btn-sm" id="pay-export">⤓ Export CSV</button>' : ''}
        </div>
      </div>
      <div class="panel-body">
        ${r.indigent === 'Yes' ? '<div class="warn-box" style="margin-bottom:12px"><b>Indigent record (Payment Method = N/A).</b> Payment details can be recorded, but Amount Paid is fixed at 0.00 and OR Number, OR Date and OR Place are disabled. Total Amount and Balance remain 0.00.</div>' : ''}
        <div class="summary-strip">
          <div class="item">Total Amount<b>${r.total}</b></div>
          <div class="item">Total Amount Paid<b style="color:var(--ok)">${h.summary.paid}</b></div>
          <div class="item">Remaining Balance<b style="color:${r.balance_cents > 0 ? 'var(--err)' : 'var(--ok)'}">${h.summary.balance}</b></div>
          <div class="item">Transactions<b>${h.summary.transaction_count}</b></div>
          <div class="item">Latest Payment Date<b>${fmtDate(h.summary.latest_payment_date) || '—'}</b></div>
        </div>
        <div class="table-wrap"><table class="grid" id="pay-table">
          <thead><tr><th>Payment ID</th><th>Date Process</th><th>Relative Name</th><th>Address</th><th>Contact</th><th>Deceased Rel.</th><th>Relative Rel.</th><th>Age</th><th class="num">Amount Paid</th><th>CTC №</th><th>CTC Date</th><th>CTC Place</th><th>OR №</th><th>OR Date</th><th>OR Place</th><th>Remarks</th></tr></thead>
          <tbody id="pay-tbody">${h.payments.length ? h.payments.map(p => `
            <tr data-pid="${p.payment_id}">
              <td>${p.payment_id}</td><td>${fmtDate(p.date_process)}</td><td class="wrap-text">${esc(p.relative_name)}</td>
              <td class="wrap-text">${esc(p.relative_address) || ''}</td><td>${esc(p.contact_number) || ''}</td>
              <td>${esc(p.deceased_relation) || ''}</td><td>${esc(p.relative_relation) || ''}</td>
              <td>${p.age != null ? p.age : ''}</td>
              <td class="num"><b>${fmtMoney(p.amount_cents)}</b></td>
              <td>${esc(p.cedula_number) || ''}</td><td>${fmtDate(p.cedula_date)}</td><td>${esc(p.cedula_place) || ''}</td>
              <td>${esc(p.or_number) || ''}</td><td>${fmtDate(p.or_date)}</td><td>${esc(p.or_place) || ''}</td>
              <td class="wrap-text">${esc(p.remarks) || ''}</td>
            </tr>`).join('') : '<tr><td colspan="16" class="muted" style="text-align:center;padding:18px">No payment transactions yet.</td></tr>'}</tbody>
        </table></div>
      </div>
    </div>`;
  State.selectedPayment = null;
  const findPay = (pid) => h.payments.find(p => p.payment_id === pid);
  $$('#pay-tbody tr[data-pid]').forEach(tr => tr.addEventListener('click', () => {
    $$('#pay-tbody tr').forEach(x => x.classList.remove('selected'));
    tr.classList.add('selected');
    State.selectedPayment = findPay(parseInt(tr.dataset.pid, 10));
    $('#pay-edit').disabled = !can('payments:update');
    const delBtn = $('#pay-del');
    if (delBtn) delBtn.disabled = !can('payments:delete');
    $('#pay-print-one').disabled = false;
  }));
  const addBtn = $('#pay-add');
  if (addBtn) addBtn.addEventListener('click', () => PaymentsUI.openForm(r));
  $('#pay-edit').addEventListener('click', () => { if (State.selectedPayment) PaymentsUI.openForm(r, State.selectedPayment); });
  on('#pay-del', 'click', async () => {
    const p = State.selectedPayment;
    if (!p) return;
    const ok = await confirmDialog(`Delete Payment ID ${p.payment_id} (${fmtMoney(p.amount_cents)} on ${fmtDate(p.date_process)})? The balance will be recalculated immediately.`, { danger: true, title: 'Delete Payment' });
    if (!ok) return;
    try {
      loading(true, 'Deleting payment…');
      await api('/api/payments/' + p.payment_id, { method: 'DELETE' });
      loading(false);
      toast('Payment deleted. Balance recalculated.');
      await RecordsUI.load();
      const h2 = await api('/api/payments/history/' + encodeURIComponent(r.control_number));
      State.selectedRecord = h2.record;
      renderPaymentPanel(h2);
    } catch (e) { loading(false); toast(e.message, 'error'); }
  });
  $('#pay-print-one').addEventListener('click', () => {
    const p = State.selectedPayment;
    if (!p) return;
    printReport(`Official Receipt / Payment Details — ${p.or_number || 'Payment ID ' + p.payment_id}`, `
      <div class="detail-list">
        <div><div class="k">Control Number</div><div class="v">${esc(r.control_number)}</div></div>
        <div><div class="k">Deceased Name</div><div class="v">${esc(r.deceased_name)}</div></div>
        <div><div class="k">Payment ID</div><div class="v">${p.payment_id}</div></div>
        <div><div class="k">Date Process</div><div class="v">${fmtDate(p.date_process)}</div></div>
        <div><div class="k">Relative Name</div><div class="v">${esc(p.relative_name)}</div></div>
        <div><div class="k">Relative Address</div><div class="v">${esc(p.relative_address) || '—'}</div></div>
        <div><div class="k">Contact Number</div><div class="v">${esc(p.contact_number) || '—'}</div></div>
        <div><div class="k">Deceased Relation</div><div class="v">${esc(p.deceased_relation) || '—'}</div></div>
        <div><div class="k">Relative Relation</div><div class="v">${esc(p.relative_relation) || '—'}</div></div>
        <div><div class="k">Age</div><div class="v">${p.age != null ? p.age : '—'}</div></div>
        <div><div class="k">Amount Paid</div><div class="v">${fmtMoney(p.amount_cents)}</div></div>
        <div><div class="k">Cedula Number (CTC)</div><div class="v">${esc(p.cedula_number) || '—'}</div></div>
        <div><div class="k">Cedula Date</div><div class="v">${fmtDate(p.cedula_date) || '—'}</div></div>
        <div><div class="k">Cedula Place</div><div class="v">${esc(p.cedula_place) || '—'}</div></div>
        <div><div class="k">OR Number</div><div class="v">${esc(p.or_number) || '—'}</div></div>
        <div><div class="k">OR Date</div><div class="v">${fmtDate(p.or_date) || '—'}</div></div>
        <div><div class="k">OR Place</div><div class="v">${esc(p.or_place) || '—'}</div></div>
        <div><div class="k">Remarks</div><div class="v">${esc(p.remarks) || '—'}</div></div>
      </div>
      <hr class="hr">
      <div class="detail-list">
        <div><div class="k">Total Amount</div><div class="v">${r.total}</div></div>
        <div><div class="k">Total Paid</div><div class="v">${h.summary.paid}</div></div>
        <div><div class="k">Remaining Balance</div><div class="v">${h.summary.balance}</div></div>
      </div>`);
  });
  $('#pay-print-hist').addEventListener('click', () => {
    printReport(`Payment History — ${r.control_number} — ${r.deceased_name}`, `
      <p><b>Control Number:</b> ${esc(r.control_number)} &nbsp; <b>Deceased:</b> ${esc(r.deceased_name)} &nbsp; <b>Burial Type:</b> ${esc(r.burial_type)} &nbsp; <b>Indigent:</b> ${r.indigent}</p>
      <table class="grid"><thead><tr><th>ID</th><th>Date</th><th>Relative</th><th>Relation</th><th>Age</th><th class="num">Amount</th><th>CTC</th><th>OR №</th><th>OR Date</th><th>Remarks</th></tr></thead>
      <tbody>${h.payments.map(p => `<tr><td>${p.payment_id}</td><td>${fmtDate(p.date_process)}</td><td>${esc(p.relative_name)}</td><td>${esc(p.relative_relation) || ''}</td><td>${p.age != null ? p.age : ''}</td><td class="num">${fmtMoney(p.amount_cents)}</td><td>${esc(p.cedula_number) || ''}</td><td>${esc(p.or_number) || ''}</td><td>${fmtDate(p.or_date)}</td><td>${esc(p.remarks) || ''}</td></tr>`).join('')}</tbody></table>
      <p style="margin-top:12px"><b>Total Amount:</b> ${r.total} &nbsp; <b>Total Paid:</b> ${h.summary.paid} &nbsp; <b>Balance:</b> ${h.summary.balance} &nbsp; <b>Transactions:</b> ${h.summary.transaction_count}</p>`);
  });
  on('#pay-export', 'click', async () => {
    try {
      const res = await fetch('/api/export/csv/payments?' + new URLSearchParams({ scope: 'filtered', control_number: r.control_number }), { headers: { Authorization: 'Bearer ' + State.token } });
      if (!res.ok) throw new Error('Export failed');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(await res.blob());
      a.download = `mpdo_payments_${r.control_number}.csv`;
      a.click(); URL.revokeObjectURL(a.href);
      toast('Payment transactions exported.');
    } catch (e) { toast(e.message, 'error'); }
  });
  panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---------- Payment form (Add / Edit) ----------
const PaymentsUI = {
  openForm(record, payment) {
    const isEdit = !!payment;
    const m = showModal({
      title: isEdit ? `Edit Payment — ID ${payment.payment_id} (${esc(record.control_number)})` : `New Payment — ${esc(record.control_number)} · ${esc(record.deceased_name)}`,
      size: 'lg',
      body: `
        <div class="warn-box no-print" style="font-size:12.5px">Recording payment for: <b>${esc(record.control_number)}</b> — <b>${esc(record.deceased_name)}</b> (Total ${record.total}, Paid ${record.paid}, Balance <b>${record.balance}</b>)</div>
        <div class="form-grid" id="pay-form">
          <div class="field"><label>Control Number</label><input class="ro" value="${esc(record.control_number)}" readonly></div>
          <div class="field"><label class="req">Date Process</label><input type="date" id="pf-dp" data-field="date_process" value="${payment ? payment.date_process : todayIso()}"><div class="field-error"></div></div>
          <div class="field"><label class="req">Relative Name</label><input id="pf-rn" data-field="relative_name" value="${esc(payment ? payment.relative_name : '')}" maxlength="150"><div class="field-error"></div></div>
          <div class="field"><label>Relative Address</label><input id="pf-ra" value="${esc(payment ? payment.relative_address || '' : '')}" maxlength="250"></div>
          <div class="field"><label>Contact Number</label><input id="pf-ct" value="${esc(payment ? payment.contact_number || '' : '')}" maxlength="50"></div>
          <div class="field"><label>Deceased Relation</label><input id="pf-dr" value="${esc(payment ? payment.deceased_relation || '' : '')}" placeholder="e.g. Wife, Son" maxlength="80"></div>
          <div class="field"><label>Relative Relation</label><input id="pf-rr" value="${esc(payment ? payment.relative_relation || '' : '')}" placeholder="e.g. Daughter" maxlength="80"></div>
          <div class="field"><label>Age</label><input id="pf-age" data-field="age" inputmode="numeric" value="${payment && payment.age != null ? payment.age : ''}" placeholder="e.g. 45"><small>Optional. Whole number, 0–150.</small><div class="field-error"></div></div>
          <div class="field"><label class="req">Amount Paid</label><input id="pf-amt" data-field="amount_paid" inputmode="decimal" value="${payment ? (payment.amount_cents / 100).toFixed(2) : ''}" placeholder="0.00"><div class="field-error"></div></div>
          <div class="field"><label>Cedula Number (CTC)</label><input id="pf-cn" value="${esc(payment ? payment.cedula_number || '' : '')}" maxlength="80"></div>
          <div class="field"><label>Cedula Date</label><input type="date" id="pf-cd" value="${payment ? payment.cedula_date || '' : ''}"></div>
          <div class="field"><label>Cedula Place</label><input id="pf-cp" value="${esc(payment ? payment.cedula_place || '' : '')}" maxlength="120"></div>
          <div class="field or-field"><label class="${record.indigent === 'Yes' ? '' : 'req'}">OR Number</label><input id="pf-or" data-field="or_number" value="${esc(payment ? payment.or_number || '' : '')}" maxlength="80"><div class="field-error"></div></div>
          <div class="field or-field"><label>OR Date</label><input type="date" id="pf-ord" value="${payment ? payment.or_date || '' : ''}"></div>
          <div class="field or-field"><label>OR Place</label><input id="pf-orp" value="${esc(payment ? payment.or_place || '' : '')}" maxlength="120"></div>
          <div class="field" style="grid-column:1/-1"><label>Remarks</label><textarea id="pf-rem" rows="2" maxlength="500">${esc(payment ? payment.remarks || '' : '')}</textarea></div>
        </div>`,
      footer: `<button class="btn" id="pf-cancel">Cancel</button>
               <button class="btn btn-primary" id="pf-save">${isEdit ? 'Update Payment' : 'Save Payment'}</button>`,
    });
    const form = $('#pay-form', m.overlay);
    // Indigent records: payment details CAN be recorded, but Amount Paid (fixed at 0.00),
    // OR Number, OR Date and OR Place are disabled - they are N/A for indigent records.
    if (record.indigent === 'Yes') {
      const amt = $('#pf-amt', m.overlay);
      if (amt) { amt.disabled = true; amt.value = payment ? (payment.amount_cents / 100).toFixed(2) : '0.00'; }
      ['pf-or', 'pf-ord', 'pf-orp'].forEach((id) => {
        const inp = $('#' + id, m.overlay);
        if (inp) { inp.disabled = true; inp.value = ''; }
      });
      const notice = el('<div class="warn-box" style="margin-bottom:12px"><b>Indigent record.</b> Amount Paid is fixed at 0.00, and OR Number, OR Date and OR Place are disabled. All other payment details can be recorded and saved.</div>');
      form.parentNode.insertBefore(notice, form);
    }
    $('#pf-cancel').onclick = () => m.close();
    $('#pf-save').onclick = async () => {
      const payload = {
        control_number: record.control_number,
        date_process: $('#pf-dp').value,
        relative_name: $('#pf-rn').value,
        relative_address: $('#pf-ra').value || null,
        contact_number: $('#pf-ct').value || null,
        deceased_relation: $('#pf-dr').value || null,
        relative_relation: $('#pf-rr').value || null,
        age: $('#pf-age').value.trim() === '' ? null : parseInt($('#pf-age').value.trim(), 10),
        amount_cents: Math.round(parseFloat($('#pf-amt').value.replace(/,/g, '')) * 100),
        cedula_number: $('#pf-cn').value || null,
        cedula_date: $('#pf-cd').value || null,
        cedula_place: $('#pf-cp').value || null,
        or_number: $('#pf-or').value || null,
        or_date: $('#pf-ord').value || null,
        or_place: $('#pf-orp').value || null,
        remarks: $('#pf-rem').value || null,
      };
      if (isNaN(payload.amount_cents)) { showFieldErrors(form, { amount_paid: 'Enter a valid amount.' }); return; }
      try {
        loading(true, isEdit ? 'Updating payment…' : 'Saving payment…');
        const d = isEdit
          ? await api('/api/payments/' + payment.payment_id, { method: 'PUT', body: JSON.stringify(payload) })
          : await api('/api/payments', { method: 'POST', body: JSON.stringify({ ...payload, client_ref: uuid() }) });
        loading(false);
        toast(isEdit ? 'Payment updated. Balance recalculated.' : `Payment saved. New balance: ${d.record.balance}`);
        m.close();
        await RecordsUI.load();
        const h = await api('/api/payments/history/' + encodeURIComponent(record.control_number));
        State.selectedRecord = h.record;
        renderPaymentPanel(h);
      } catch (e) {
        loading(false);
        showFieldErrors(form, e.data && e.data.errors);
        if (!(e.data && e.data.errors)) toast(e.message, 'error');
      }
    };
  },
};

// ---------- Print helper (print-friendly window, all local) ----------
function printReport(title, bodyHtml) {
  const w = window.open('', '_blank', 'width=1000,height=760');
  if (!w) return toast('Please allow pop-ups to print reports.', 'error');
  w.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(title)} — MPDO Cemetery Record System</title>
    <link rel="stylesheet" href="/css/styles.css">
    <style>body{padding:26px;background:#fff}.print-doc{max-width:1100px;margin:0 auto}.grid th{background:#1e3a5f !important;-webkit-print-color-adjust:exact}</style>
    </head><body><div class="print-doc">
    <h1>MPDO CEMETERY RECORD SYSTEM</h1>
    <p class="meta">${esc(title)} · Printed ${new Date().toLocaleString()}</p>
    ${bodyHtml}
    <p class="meta" style="margin-top:24px;border-top:1px solid #ccc;padding-top:8px">Generated by ${esc(State.user ? State.user.fullName : '')} (${esc(State.user ? State.user.role : '')}) — Offline System</p>
    </div><script>window.onload=function(){setTimeout(function(){window.print()},300)}<\/script></body></html>`);
  w.document.close();
}

// ======================= USER MANAGEMENT =======================
Pages.users = {
  title: 'User Management',
  async render(root) {
    if (!can('users:manage')) { root.innerHTML = '<div class="error-box">Only administrators can manage users.</div>'; return; }
    root.innerHTML = `
      <div class="panel">
        <div class="panel-head"><h3>User Accounts</h3><div class="toolbar">
          <button class="btn btn-sm" id="usr-export">⤓ Export CSV</button>
          <button class="btn btn-primary btn-sm" id="usr-new">＋ Add User</button></div></div>
        <div class="panel-body" style="padding:0"><div class="table-wrap"><table class="grid">
          <thead><tr><th>User ID</th><th>Full Name</th><th>Username</th><th>Role</th><th>Status</th><th>Date Created</th><th>Actions</th></tr></thead>
          <tbody id="usr-tbody"></tbody></table></div></div>
      </div>`;
    const load = async () => {
      const d = await api('/api/users');
      $('#usr-tbody').innerHTML = d.users.map(u => `
        <tr>
          <td>${u.user_id}</td><td class="wrap-text">${esc(u.full_name)}</td><td>${esc(u.username)}</td>
          <td><span class="tag ${u.role === 'Administrator' ? 'tag-indigent' : u.role === 'Staff' ? 'tag-partial' : 'tag-unpaid'}">${u.role}</span></td>
          <td><span class="tag ${u.account_status === 'Active' ? 'tag-paid' : 'tag-unpaid'}">${u.account_status}</span></td>
          <td>${fmtDate((u.date_created || '').slice(0, 10))}</td>
          <td style="white-space:nowrap">
            <button class="btn btn-sm" data-act="edit" data-id="${u.user_id}">Edit</button>
            <button class="btn btn-sm" data-act="pw" data-id="${u.user_id}">Reset PW</button>
            <button class="btn btn-sm ${u.account_status === 'Active' ? 'btn-warn' : 'btn-success'}" data-act="toggle" data-id="${u.user_id}">${u.account_status === 'Active' ? 'Deactivate' : 'Activate'}</button>
            <button class="btn btn-sm btn-danger" data-act="del" data-id="${u.user_id}">Delete</button>
          </td>
        </tr>`).join('') || '<tr><td colspan="7" class="muted" style="text-align:center;padding:18px">No users.</td></tr>';
      $$('#usr-tbody button').forEach(b => b.addEventListener('click', () => {
        const u = d.users.find(x => x.user_id === parseInt(b.dataset.id, 10));
        if (b.dataset.act === 'edit') UsersUI.form(u, load);
        if (b.dataset.act === 'pw') UsersUI.resetPw(u, load);
        if (b.dataset.act === 'toggle') UsersUI.toggle(u, load);
        if (b.dataset.act === 'del') UsersUI.del(u, load);
      }));
    };
    $('#usr-new').addEventListener('click', () => UsersUI.form(null, load));
    $('#usr-export').addEventListener('click', async () => {
      try {
        const res = await fetch('/api/export/csv/users', { headers: { Authorization: 'Bearer ' + State.token } });
        if (!res.ok) throw new Error('Export failed');
        const a = document.createElement('a'); a.href = URL.createObjectURL(await res.blob());
        a.download = `mpdo_users_${todayIso()}.csv`; a.click(); URL.revokeObjectURL(a.href);
        toast('User accounts exported (no password data included).');
      } catch (e) { toast(e.message, 'error'); }
    });
    await load();
  },
};

const UsersUI = {
  form(u, reload) {
    const isEdit = !!u;
    const m = showModal({
      title: isEdit ? `Edit User — ${u.username}` : 'Add User',
      body: `<div class="form-grid" id="usr-form">
        <div class="field"><label class="req">Full Name</label><input id="uf-name" value="${esc(u ? u.full_name : '')}" maxlength="100"></div>
        <div class="field"><label class="req">Username</label><input id="uf-user" value="${esc(u ? u.username : '')}" ${isEdit ? 'readonly class="ro"' : ''} maxlength="30"></div>
        <div class="field"><label class="req">Role</label><select id="uf-role">${['Administrator', 'Staff', 'Viewer'].map(r => `<option ${u && u.role === r ? 'selected' : ''}>${r}</option>`).join('')}</select><small>Viewer = read-only. Staff = records + payments. Admin = full access.</small></div>
        <div class="field"><label>Account Status</label><select id="uf-status"><option ${u && u.account_status === 'Active' ? 'selected' : ''}>Active</option><option ${u && u.account_status === 'Inactive' ? 'selected' : ''}>Inactive</option></select></div>
        <div class="field" style="grid-column:1/-1"><label class="${isEdit ? '' : 'req'}">${isEdit ? 'New Password (leave blank to keep current)' : 'Password'}</label><input type="password" id="uf-pw" minlength="8" autocomplete="new-password"><small>Minimum 8 characters. Stored with salted bcrypt hashing — never in plain text.</small></div>
      </div>`,
      footer: `<button class="btn" id="uf-cancel">Cancel</button><button class="btn btn-primary" id="uf-save">${isEdit ? 'Update User' : 'Create User'}</button>`,
    });
    $('#uf-cancel').onclick = () => m.close();
    $('#uf-save').onclick = async () => {
      const payload = {
        full_name: $('#uf-name').value, role: $('#uf-role').value, account_status: $('#uf-status').value,
        password: $('#uf-pw').value || undefined,
      };
      if (!isEdit) payload.username = $('#uf-user').value;
      try {
        loading(true, isEdit ? 'Updating user…' : 'Creating user…');
        if (isEdit) await api('/api/users/' + u.user_id, { method: 'PUT', body: JSON.stringify(payload) });
        else await api('/api/users', { method: 'POST', body: JSON.stringify(payload) });
        loading(false);
        toast(isEdit ? 'User updated.' : 'User created.');
        m.close(); reload();
      } catch (e) { loading(false); toast(e.message, 'error'); }
    };
  },
  async resetPw(u, reload) {
    const m = showModal({
      title: `Reset Password — ${u.username}`, size: 'sm',
      body: `<div class="field"><label class="req">New Password</label><input type="password" id="rp-pw" minlength="8"></div>
             <div class="field" style="margin-top:10px"><label class="req">Confirm Password</label><input type="password" id="rp-pw2" minlength="8"></div>
             <p class="muted" style="font-size:12px">The user will be signed out of all sessions.</p>`,
      footer: `<button class="btn" id="rp-cancel">Cancel</button><button class="btn btn-primary" id="rp-save">Reset Password</button>`,
    });
    $('#rp-cancel').onclick = () => m.close();
    $('#rp-save').onclick = async () => {
      if ($('#rp-pw').value !== $('#rp-pw2').value) return toast('Passwords do not match.', 'error');
      try {
        await api('/api/users/' + u.user_id, { method: 'PUT', body: JSON.stringify({ password: $('#rp-pw').value }) });
        toast('Password reset.'); m.close(); reload();
      } catch (e) { toast(e.message, 'error'); }
    };
  },
  async toggle(u, reload) {
    const target = u.account_status === 'Active' ? 'Inactive' : 'Active';
    const ok = await confirmDialog(`${target === 'Inactive' ? 'Deactivate' : 'Activate'} account "${u.username}"?`, { danger: target === 'Inactive' });
    if (!ok) return;
    try { await api('/api/users/' + u.user_id, { method: 'PUT', body: JSON.stringify({ account_status: target }) }); toast(`Account ${target.toLowerCase()}.`); reload(); }
    catch (e) { toast(e.message, 'error'); }
  },
  async del(u, reload) {
    const ok = await confirmDialog(`Delete user "${u.username}" permanently?`, { danger: true });
    if (!ok) return;
    try { await api('/api/users/' + u.user_id, { method: 'DELETE' }); toast('User deleted.'); reload(); }
    catch (e) { toast(e.message, 'error'); }
  },
};

// ======================= REPORTS =======================
const REPORT_DEFS = [
  ['complete', 'Complete Cemetery Records'],
  ['by-burial-type', 'Records by Burial Type'],
  ['indigent', 'Indigent Records'],
  ['installment', 'Installment Accounts'],
  ['full-payment', 'Full Payment Accounts'],
  ['paid', 'Paid Records'],
  ['partial', 'Partial Payment Records'],
  ['unpaid', 'Unpaid Records'],
  ['transactions', 'Payment Transactions by Date Range'],
  ['or-transactions', 'Official Receipt Transactions'],
  ['outstanding', 'Outstanding Balances'],
  ['collection-summary', 'Collection Summary by Month/Year'],
  ['history', 'Individual Deceased Payment History'],
];

Pages.reports = {
  title: 'Reports',
  async render(root) {
    root.innerHTML = `
      <div class="panel"><div class="panel-head"><h3>Generate Report</h3></div><div class="panel-body">
        <div class="form-grid">
          <div class="field"><label>Report Type</label><select id="rp-type">${REPORT_DEFS.map(([v, t]) => `<option value="${v}">${t}</option>`).join('')}</select></div>
          <div class="field"><label>Date From</label><input type="date" id="rp-from"></div>
          <div class="field"><label>Date To</label><input type="date" id="rp-to"></div>
          <div class="field"><label>Control Number</label><input id="rp-cn" placeholder="e.g. 2026-001"></div>
          <div class="field"><label>Deceased Name</label><input id="rp-name"></div>
          <div class="field"><label>Burial Type</label><select id="rp-burial"><option value="">All</option>${BURIAL_TYPES.map(t => `<option>${t}</option>`).join('')}</select></div>
          <div class="field"><label>Indigent</label><select id="rp-indigent"><option value="">All</option><option>Yes</option><option>No</option></select></div>
          <div class="field"><label>Payment Method</label><select id="rp-pm"><option value="">All</option><option>Installment</option><option>Full Payment (Cash)</option><option>N/A</option></select></div>
          <div class="field"><label>Collection Grouping</label><select id="rp-group"><option value="month">By Month</option><option value="year">By Year</option></select></div>
        </div>
        <div style="margin-top:14px;display:flex;gap:9px;flex-wrap:wrap">
          <button class="btn btn-primary" id="rp-run">Generate</button>
          <button class="btn" id="rp-print" disabled>🖨 Print Report</button>
          ${can('export:csv') ? '<button class="btn" id="rp-export" disabled>⤓ Export CSV</button>' : ''}
        </div>
      </div></div>
      <div class="panel" id="rp-results-panel" style="display:none"><div class="panel-head"><h3 id="rp-title"></h3><span id="rp-summary" class="muted"></span></div><div class="panel-body" style="padding:0"><div class="table-wrap" id="rp-results"></div></div></div>`;
    let lastResult = null, lastType = null;
    const collectQ = () => ({
      type: $('#rp-type').value,
      date_from: $('#rp-from').value, date_to: $('#rp-to').value,
      control_number: $('#rp-cn').value.trim(), search: $('#rp-name').value.trim(),
      burial_type: $('#rp-burial').value, indigent: $('#rp-indigent').value, payment_method: $('#rp-pm').value,
      group_by: $('#rp-group').value,
    });
    $('#rp-run').addEventListener('click', async () => {
      const q = collectQ();
      try {
        loading(true, 'Generating report…');
        const params = new URLSearchParams();
        for (const [k, v] of Object.entries(q)) if (v && k !== 'type') params.set(k, v);
        const d = await api('/api/reports/' + q.type + '?' + params);
        loading(false);
        lastResult = d; lastType = q.type;
        $('#rp-results-panel').style.display = '';
        $('#rp-title').textContent = d.title;
        const s = d.summary || {};
        $('#rp-summary').textContent = [s.count != null ? `${s.count} row(s)` : '', s.total != null ? `Total ${s.total}` : '', s.paid != null ? `Collected ${s.paid}` : '', s.balance != null ? `Balance ${s.balance}` : ''].filter(Boolean).join(' · ');
        $('#rp-results').innerHTML = ReportsUI.renderTable(d);
        $('#rp-print').disabled = false;
        const rpExp = $('#rp-export');
        if (rpExp) rpExp.disabled = false;
      } catch (e) { loading(false); toast(e.message, 'error'); }
    });
    $('#rp-print').addEventListener('click', () => { if (lastResult) printReport(lastResult.title, ReportsUI.renderTable(lastResult, true)); });
    on('#rp-export', 'click', async () => {
      const q = collectQ();
      try {
        const params = new URLSearchParams({ scope: 'filtered' });
        for (const [k, v] of Object.entries(q)) if (v && k !== 'type' && k !== 'group_by') params.set(k, v);
        const res = await fetch('/api/export/csv/' + (['transactions', 'or-transactions', 'collection-summary'].includes(q.type) ? 'payments' : 'records') + '?' + params, { headers: { Authorization: 'Bearer ' + State.token } });
        if (!res.ok) throw new Error('Export failed');
        const a = document.createElement('a'); a.href = URL.createObjectURL(await res.blob());
        a.download = `mpdo_report_${q.type}_${todayIso()}.csv`; a.click(); URL.revokeObjectURL(a.href);
        toast('Report exported to CSV.');
      } catch (e) { toast(e.message, 'error'); }
    });
  },
};

const ReportsUI = {
  renderTable(d, forPrint) {
    if (d.group_rows) {
      return `<table class="grid"><thead><tr><th>Burial Type</th><th class="num">Records</th><th class="num">Total</th><th class="num">Collected</th><th class="num">Balance</th></tr></thead><tbody>
        ${d.group_rows.map(g => `<tr><td>${esc(g.burial_type)}</td><td class="num">${g.count}</td><td class="num">${g.total}</td><td class="num">${g.paid}</td><td class="num">${g.balance}</td></tr>`).join('')}</tbody></table>`;
    }
    if (d.collection_rows) {
      return `<table class="grid"><thead><tr><th>Period</th><th class="num">Transactions</th><th class="num">Amount Collected</th></tr></thead><tbody>
        ${d.collection_rows.map(r => `<tr><td>${esc(r.period)}</td><td class="num">${r.count}</td><td class="num">${r.amount}</td></tr>`).join('')}</tbody></table>`;
    }
    if (d.records && d.records.length !== undefined && d.payments && d.payments.length !== undefined && d.records.length === 0 && d.payments.length === 0 && !d.payments) {
      return '<p class="muted" style="padding:18px">No rows.</p>';
    }
    if (d.payments && d.payments.length) {
      return `<table class="grid"><thead><tr><th>ID</th><th>Control №</th><th>Date</th><th>Relative</th><th class="num">Amount</th><th>CTC</th><th>OR №</th><th>OR Date</th><th>OR Place</th><th>Remarks</th></tr></thead><tbody>
        ${d.payments.map(p => `<tr><td>${p.payment_id}</td><td>${esc(p.control_number)}</td><td>${fmtDate(p.date_process)}</td><td class="wrap-text">${esc(p.relative_name)}</td><td class="num">${fmtMoney(p.amount_cents)}</td><td>${esc(p.cedula_number) || ''}</td><td>${esc(p.or_number) || ''}</td><td>${fmtDate(p.or_date)}</td><td>${esc(p.or_place) || ''}</td><td class="wrap-text">${esc(p.remarks) || ''}</td></tr>`).join('')}</tbody></table>`;
    }
    if (d.records && d.records.length) {
      return `<table class="grid"><thead><tr><th>Control №</th><th>Deceased Name</th><th>Death</th><th>Burial</th><th>Ind.</th><th>Burial Type</th><th>Method</th><th class="num">Total</th><th class="num">Paid</th><th class="num">Balance</th><th>Latest Date</th><th>Latest Remarks</th></tr></thead><tbody>
        ${d.records.map(r => `<tr><td>${esc(r.control_number)}</td><td class="wrap-text">${esc(r.deceased_name)}</td><td>${fmtDate(r.date_of_death)}</td><td>${fmtDate(r.date_of_burial)}</td><td>${r.indigent}</td><td>${esc(r.burial_type)}</td><td>${esc(r.payment_method)}</td><td class="num">${fmtMoney(r.total_cents)}</td><td class="num">${fmtMoney(r.paid_cents)}</td><td class="num">${fmtMoney(r.balance_cents)}</td><td>${fmtDate(r.latest_date_process)}</td><td class="wrap-text">${esc(r.latest_remarks) || ''}</td></tr>`).join('')}</tbody></table>`;
    }
    return '<p class="muted" style="padding:18px">No rows for the selected filters.</p>';
  },
};

// ======================= CSV IMPORT / EXPORT =======================
Pages.csv = {
  title: 'CSV Import / Export',
  async render(root) {
    root.innerHTML = `
      <div class="panel"><div class="panel-head"><h3>Export to CSV</h3></div><div class="panel-body">
        <p class="muted" style="margin-top:0">Exports UTF-8 CSV files compatible with Microsoft Excel and Google Sheets. Amounts use plain numeric values with two decimals; dates use <code>yyyy-MM-dd</code> in templates and <code>MM/dd/yyyy</code> in data exports.</p>
        <div style="display:flex;gap:9px;flex-wrap:wrap">
          ${can('export:csv') ? '<button class="btn" id="cx-records">⤓ Main Cemetery Records</button><button class="btn" id="cx-payments">⤓ Payment Transactions</button>' : '<span class="muted">CSV export is not available for your role.</span>'}
          <button class="btn admin-only ${State.user.role !== 'Administrator' ? 'hidden' : ''}" id="cx-users">⤓ User Accounts (no credentials)</button>
        </div>
      </div></div>
      <div class="panel"><div class="panel-head"><h3>CSV Templates</h3></div><div class="panel-body">
        <div style="display:flex;gap:9px;flex-wrap:wrap">
          <button class="btn" id="tpl-records">⤓ Template: Main Cemetery Records</button>
          <button class="btn" id="tpl-payments">⤓ Template: Payment Transactions</button>
          <button class="btn" id="tpl-users">⤓ Template: User Accounts (headers only)</button>
        </div>
      </div></div>
      <div class="panel"><div class="panel-head"><h3>Import CSV (Administrator)</h3></div><div class="panel-body">
        <div class="steps"><span class="step active" data-s="1">1. Select</span><span class="step" data-s="2">2. Map Columns</span><span class="step" data-s="3">3. Preview &amp; Validate</span><span class="step" data-s="4">4. Import</span></div>
        <div id="imp-area"></div>
      </div></div>`;
    const dl = async (path, name) => {
      try {
        const res = await fetch(path, { headers: { Authorization: 'Bearer ' + State.token } });
        if (!res.ok) throw new Error((await res.json()).error || 'Download failed');
        const a = document.createElement('a'); a.href = URL.createObjectURL(await res.blob());
        a.download = name; a.click(); URL.revokeObjectURL(a.href);
        toast('Downloaded ' + name);
      } catch (e) { toast(e.message, 'error'); }
    };
    const exportEntity = async (entity) => {
      const all = await confirmDialog('Export ALL records, or only currently filtered results (on the Records page)?', {
        title: 'Export ' + entity, extra: '<p class="muted" style="font-size:12.5px">OK = all &nbsp;|&nbsp; Cancel = filtered (uses Records page filters)</p>' });
      try {
        const params = new URLSearchParams({ scope: all ? 'all' : 'filtered' });
        if (!all) for (const [k, v] of Object.entries(State.recordFilters)) if (v) params.set(k, v);
        const res = await fetch(`/api/export/csv/${entity}?` + params, { headers: { Authorization: 'Bearer ' + State.token } });
        if (!res.ok) throw new Error('Export failed');
        const a = document.createElement('a'); a.href = URL.createObjectURL(await res.blob());
        a.download = `mpdo_${entity}_${todayIso()}.csv`; a.click(); URL.revokeObjectURL(a.href);
        toast('Export complete.');
      } catch (e) { toast(e.message, 'error'); }
    };
    on('#cx-records', 'click', () => exportEntity('records'));
    on('#cx-payments', 'click', () => exportEntity('payments'));
    on('#cx-users', 'click', () => exportEntity('users'));
    $('#tpl-records').onclick = () => dl('/api/import/templates/records', 'mpdo_template_records.csv');
    $('#tpl-payments').onclick = () => dl('/api/import/templates/payments', 'mpdo_template_payments.csv');
    $('#tpl-users').onclick = () => dl('/api/export/csv/users', 'mpdo_template_users.csv');
    if (can('import:csv')) ImportUI.mount($('#imp-area'));
    else $('#imp-area').innerHTML = '<div class="warn-box"><b>Administrator only.</b> Importing, bulk updating, or replacing data is restricted to Administrator accounts.</div>';
  },
};

const ImportUI = {
  state: { entity: 'records', csvText: null, fileName: '', preview: null, mapping: null, headers: null, mode: 'add' },
  setStep(n) { $$('#imp-area').length; $$('.step').forEach(s => { const sn = parseInt(s.dataset.s, 10); s.classList.toggle('active', sn === n); s.classList.toggle('done', sn < n); }); },
  mount(root) { this.root = root; this.step1(); },
  step1() {
    this.setStep(1);
    this.root.innerHTML = `
      <div class="form-grid">
        <div class="field"><label>Import Type</label><select id="imp-entity"><option value="records">Main Cemetery Records</option><option value="payments">Payment Transactions</option></select></div>
        <div class="field"><label>CSV File</label><input type="file" id="imp-file" accept=".csv,text/csv"></div>
      </div>
      <p class="muted" style="font-size:12.5px">Tip: for full migration, import main cemetery records first, then their payment transactions. Original Control Numbers are preserved.</p>
      <div id="imp-msg"></div>
      <div style="margin-top:12px"><button class="btn btn-primary" id="imp-next" disabled>Next: Map Columns →</button></div>`;
    const self = this;
    $('#imp-entity').onchange = () => { self.state.entity = $('#imp-entity').value; };
    $('#imp-file').onchange = async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      self.state.fileName = f.name;
      self.state.csvText = await f.text();
      $('#imp-next').disabled = false;
      $('#imp-msg').innerHTML = `<div class="ok-box">Loaded <b>${esc(f.name)}</b> (${(f.size / 1024).toFixed(1)} KB).</div>`;
    };
    $('#imp-next').onclick = () => { if (self.state.csvText) self.step2(); };
  },
  async step2() {
    this.setStep(2);
    try {
      loading(true, 'Parsing CSV…');
      const d = await api('/api/import/preview', { method: 'POST', body: JSON.stringify({ entity: this.state.entity, csv_text: this.state.csvText }) });
      loading(false);
      this.state.preview = d;
      this.state.headers = d.headers;
      this.state.mapping = d.auto_map.slice();
      this.renderMapping(d);
    } catch (e) { loading(false); toast(e.message, 'error'); }
  },
  renderMapping(d) {
    const self = this;
    const fieldOptions = (entity) => entity === 'records'
      ? [['', '— skip —'], ['control_number', 'Control Number'], ['deceased_name', 'Deceased Name'], ['date_of_death', 'Date of Death'], ['date_of_burial', 'Date of Burial'], ['burial_type', 'Burial Type'], ['indigent', 'Indigent'], ['payment_method', 'Payment Method'], ['total_cents', 'Total Amount'], ['paid_display', 'Total Amount Paid (ref.)'], ['balance_display', 'Balance (ref.)'], ['latest_display', 'Latest Date Process (ref.)'], ['latest_remarks', 'Latest Remarks (ref.)']]
      : [['', '— skip —'], ['payment_id', 'Payment ID'], ['control_number', 'Control Number'], ['date_process', 'Date Process'], ['relative_name', 'Relative Name'], ['relative_address', 'Relative Address'], ['contact_number', 'Contact Number'], ['deceased_relation', 'Deceased Relation'], ['relative_relation', 'Relative Relation'], ['amount_cents', 'Amount Paid'], ['cedula_number', 'Cedula Number (CTC)'], ['cedula_date', 'Cedula Date'], ['cedula_place', 'Cedula Place'], ['or_number', 'OR Number'], ['or_date', 'OR Date'], ['or_place', 'OR Place'], ['remarks', 'Remarks']];
    const opts = fieldOptions(this.state.entity);
    this.root.innerHTML = `
      <p>File: <b>${esc(this.state.fileName)}</b> — map each CSV column to an application field. Auto-detected mappings are pre-selected.</p>
      <div class="table-wrap"><table class="grid"><thead><tr><th>CSV Column</th><th>Sample Value</th><th>Maps To</th></tr></thead><tbody>
        ${d.headers.map((h, i) => {
          return `<tr><td><b>${esc(h)}</b></td><td class="muted" id="samp-${i}">…</td><td><select data-col="${i}">${opts.map(([v, t]) => `<option value="${v}" ${d.auto_map[i] === v ? 'selected' : ''}>${t}</option>`).join('')}</select></td></tr>`;
        }).join('')}
      </tbody></table></div>
      <p class="muted" style="font-size:12.5px">Note: rows must still pass validation (see next step). Reference columns (Total Amount Paid, Balance, Latest…) are optional and ignored on import.</p>
      <div style="margin-top:12px;display:flex;gap:9px"><button class="btn" id="imp-back">← Back</button><button class="btn btn-primary" id="imp-validate">Next: Preview &amp; Validate →</button></div>
      <div id="imp-preview"></div>`;
    $$('#imp-area select[data-col]').forEach(sel => sel.addEventListener('change', () => {
      self.state.mapping[parseInt(sel.dataset.col, 10)] = sel.value;
    }));
    $('#imp-back').onclick = () => this.step1();
    $('#imp-validate').onclick = () => this.step3();
  },
  async step3() {
    this.setStep(3);
    try {
      loading(true, 'Validating rows…');
      const d = await api('/api/import/preview', { method: 'POST', body: JSON.stringify({ entity: this.state.entity, csv_text: this.state.csvText, mapping: this.state.mapping }) });
      loading(false);
      this.state.preview = d;
      const errRows = {};
      (d.errors || []).forEach(e => { (errRows[e.row] = errRows[e.row] || []).push(e); });
      this.root.innerHTML = `
        <div class="summary-strip">
          <div class="item">Valid Rows<b style="color:var(--ok)">${d.stats.valid}</b></div>
          <div class="item">Invalid Rows<b style="color:var(--err)">${d.stats.invalid}</b></div>
          <div class="item">Duplicate Rows<b style="color:var(--warn)">${d.stats.duplicates}</b></div>
          <div class="item">Ready to Import<b>${d.stats.ready}</b></div>
        </div>
        ${d.errors.length ? `<div class="panel" style="margin-bottom:12px"><div class="panel-head"><h3 style="color:var(--err)">Error Report (${d.errors.length} issue(s)) — fix these in your CSV and retry</h3><button class="btn btn-sm" id="imp-err-csv">⤓ Export Error Report</button></div><div class="panel-body" style="max-height:220px;overflow:auto">
          <table class="grid"><thead><tr><th>CSV Row</th><th>Field</th><th>Reason</th></tr></thead><tbody>
          ${d.errors.map(e => `<tr><td>${e.row}</td><td>${esc(e.field)}</td><td>${esc(e.reason)}</td></tr>`).join('')}</tbody></table></div></div>` : '<div class="ok-box">All rows passed validation.</div>'}
        <div class="field" style="max-width:420px"><label>Import Mode</label><select id="imp-mode">
          <option value="add">Add New Records (skip existing)</option>
          <option value="update">Update Existing Records (skip new)</option>
          <option value="replace">Replace All Data (administrator only — automatic backup first)</option>
        </select></div>
        <div style="margin-top:12px;display:flex;gap:9px"><button class="btn" id="imp-back2">← Back to Mapping</button>
        <button class="btn btn-success" id="imp-commit" ${d.stats.ready === 0 ? 'disabled' : ''}>Import ${d.stats.ready} Row(s)</button></div>`;
      $('#imp-back2').onclick = () => this.step2();
      const errBtn = $('#imp-err-csv');
      if (errBtn) errBtn.onclick = () => {
        const rows = d.errors.map(e => [e.row, e.field, e.reason]);
        const blob = new Blob(['﻿CSV Row,Field,Reason\r\n' + rows.map(r => r.map(x => `"${String(x).replace(/"/g, '""')}"`).join(',')).join('\r\n')], { type: 'text/csv' });
        const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'mpdo_import_errors.csv'; a.click(); URL.revokeObjectURL(a.href);
      };
      $('#imp-commit').onclick = async () => {
        const mode = $('#imp-mode').value;
        if (mode === 'replace') {
          const ok1 = await confirmDialog('REPLACE ALL DATA will permanently DELETE the existing dataset and replace it with this CSV. A safety backup is created automatically. This cannot be undone lightly.', { danger: true, title: 'Destructive: Replace All Data' });
          if (!ok1) return;
          const ok2 = await confirmDialog('Final confirmation: type-risk accepted. Proceed with full data replacement?', { danger: true, title: 'Final Confirmation' });
          if (!ok2) return;
        }
        try {
          loading(true, 'Importing (transactional)…');
          const d2 = await api('/api/import/commit', { method: 'POST', body: JSON.stringify({ entity: this.state.entity, rows: d.rows, mode, errors: d.errors }) });
          loading(false);
          toast(`Import complete: ${d2.summary.added} added, ${d2.summary.updated} updated, ${d2.summary.skipped} skipped.`);
          this.step4(d2);
        } catch (e) {
          loading(false);
          if (e.data && e.data.summary) { this.step4({ ...e.data, failed: true }); }
          else toast(e.message, 'error');
        }
      };
    } catch (e) { loading(false); toast(e.message, 'error'); }
  },
  step4(d) {
    this.setStep(4);
    const s = d.summary;
    this.root.innerHTML = `
      <div class="${d.failed || (s.errors && s.errors.length) ? 'warn-box' : 'ok-box'}">
        <b>${d.failed ? 'Import rolled back — no data was changed.' : 'Import completed successfully.'}</b><br>
        Added: <b>${s.added}</b> · Updated: <b>${s.updated}</b> · Skipped: <b>${s.skipped}</b>
        ${s.errors && s.errors.length ? ` · Row errors (rejected): <b>${s.errors.length}</b>` : ''}
        ${d.backup_path ? `<br>Safety backup: <code>${esc(d.backup_path)}</code>` : ''}
      </div>
      ${s.errors && s.errors.length ? `<div class="panel"><div class="panel-head"><h3>Rejected Rows</h3></div><div class="panel-body" style="max-height:220px;overflow:auto"><table class="grid"><thead><tr><th>Row</th><th>Field</th><th>Reason</th></tr></thead><tbody>${s.errors.map(e => `<tr><td>${e.row}</td><td>${esc(e.field)}</td><td>${esc(e.reason)}</td></tr>`).join('')}</tbody></table></div></div>` : ''}
      <p class="muted">Balances and latest-payment information for all affected Control Numbers were recalculated automatically.</p>
      <div style="display:flex;gap:9px"><button class="btn btn-primary" id="imp-again">Start Another Import</button><button class="btn" id="imp-gorecords">Go to Cemetery Records</button></div>`;
    $('#imp-again').onclick = () => this.step1();
    $('#imp-gorecords').onclick = () => navigate('records');
  },
};

// ======================= BACKUP & RESTORE =======================
Pages.backup = {
  title: 'Backup & Restore',
  async render(root) {
    if (State.user.role !== 'Administrator') { root.innerHTML = '<div class="error-box">Only administrators can manage backups.</div>'; return; }
    root.innerHTML = '<p class="muted">Loading…</p>';
    const d = await api('/api/backup/list');
    const lastBk = d.last_backup ? JSON.parse(d.last_backup) : null;
    root.innerHTML = `
      <div class="panel"><div class="panel-head"><h3>Database Backup</h3></div><div class="panel-body">
        <div class="detail-list" style="margin-bottom:14px">
          <div><div class="k">Database File</div><div class="v" style="font-size:12px;overflow-wrap:anywhere">${esc(d.db_path)}</div></div>
          <div><div class="k">Last Backup</div><div class="v">${lastBk ? new Date(lastBk.date).toLocaleString() : 'Never'}</div></div>
          <div><div class="k">Last Backup Status</div><div class="v">${lastBk ? lastBk.status : '—'}</div></div>
          <div><div class="k">Last Backup Location</div><div class="v" style="font-size:12px;overflow-wrap:anywhere">${esc(lastBk ? lastBk.path : '')}</div></div>
        </div>
        <div class="field" style="max-width:560px"><label>Destination Folder (optional — blank = app backups folder)</label><input id="bk-dir" placeholder="e.g. D:\\MPDO-Backups"></div>
        <div style="margin-top:12px"><button class="btn btn-primary" id="bk-create">💾 Create Backup Now</button></div>
      </div></div>
      <div class="panel"><div class="panel-head"><h3>Available Backups</h3><button class="btn btn-sm" id="bk-refresh">⟳ Refresh</button></div><div class="panel-body" style="padding:0"><div class="table-wrap"><table class="grid">
        <thead><tr><th>File</th><th>Date</th><th class="num">Size</th><th>Actions</th></tr></thead>
        <tbody id="bk-tbody">${d.backups.map(b => `<tr><td style="overflow-wrap:anywhere">${esc(b.name)}</td><td>${new Date(b.mtime).toLocaleString()}</td><td class="num">${(b.size / 1024).toFixed(1)} KB</td><td><button class="btn btn-sm" data-path="${esc(b.path)}" data-act="restore">Restore</button></td></tr>`).join('') || '<tr><td colspan="4" class="muted" style="text-align:center;padding:16px">No backups yet.</td></tr>'}</tbody>
      </table></div></div></div>
      <div class="panel"><div class="panel-head"><h3>Restore From File</h3></div><div class="panel-body">
        <p class="muted" style="margin-top:0">Restore a backup file created by this system or located in any folder. The file is validated (required tables + integrity check) before anything is replaced, and a safety backup of the current data is created first.</p>
        <div class="field" style="max-width:560px"><label>Backup File Path</label><input id="rs-path" placeholder="e.g. D:\\MPDO-Backups\\mpdo_backup_2026-01-01.db"></div>
        <div style="margin-top:12px;display:flex;gap:9px"><button class="btn" id="rs-validate">1. Validate File</button><button class="btn btn-danger" id="rs-restore" disabled>2. Restore (Overwrite Current Data)</button></div>
        <div id="rs-msg" style="margin-top:12px"></div>
      </div></div>`;
    $('#bk-create').addEventListener('click', async () => {
      try {
        loading(true, 'Creating backup…');
        const r = await api('/api/backup/create', { method: 'POST', body: JSON.stringify({ dest_dir: $('#bk-dir').value.trim() }) });
        loading(false);
        toast('Backup created: ' + r.backup.path);
        this.render(root);
      } catch (e) { loading(false); toast(e.message, 'error'); }
    });
    $('#bk-refresh').addEventListener('click', () => this.render(root));
    $$('#bk-tbody button[data-act="restore"]').forEach(b => b.addEventListener('click', () => { $('#rs-path').value = b.dataset.path; $('#rs-path').scrollIntoView(); }));
    let validatedPath = null;
    $('#rs-validate').addEventListener('click', async () => {
      const p = $('#rs-path').value.trim();
      if (!p) return toast('Enter a backup file path.', 'error');
      try {
        loading(true, 'Validating backup file…');
        const v = await api('/api/backup/validate', { method: 'POST', body: JSON.stringify({ path: p }) });
        loading(false);
        $('#rs-msg').innerHTML = `<div class="${v.valid ? 'ok-box' : 'error-box'}">${v.valid ? '✓ Valid MPDO database backup.' : '✗ Not a valid backup.'}
          <br>Checks: ${v.checks.map(c => `${c.ok ? '✓' : '✗'} ${esc(c.name)}`).join(' · ')}
          ${v.counts ? `<br>Contents: ${v.counts.records} records, ${v.counts.payments} payments, ${v.counts.users} users.` : ''}</div>`;
        validatedPath = v.valid ? p : null;
        $('#rs-restore').disabled = !v.valid;
      } catch (e) { loading(false); $('#rs-msg').innerHTML = `<div class="error-box">${esc(e.message)}</div>`; }
    });
    $('#rs-restore').addEventListener('click', async () => {
      if (!validatedPath) return;
      const ok = await confirmDialog(`Restoring will OVERWRITE ALL current data (records, payments, accounts) with the contents of:\n${validatedPath}\n\nA safety backup of the current database is created first. Continue?`, { danger: true, title: 'Restore Database — Overwrite Data' });
      if (!ok) return;
      try {
        loading(true, 'Restoring database…');
        const r = await api('/api/restore', { method: 'POST', body: JSON.stringify({ path: validatedPath }) });
        loading(false);
        toast(`Restore complete from ${r.restored_from}. Safety backup: ${r.backup_before_restore}`);
        setTimeout(() => location.reload(), 1200);
      } catch (e) { loading(false); $('#rs-msg').innerHTML = `<div class="error-box">${esc(e.message)}</div>`; }
    });
  },
};

// ======================= SETTINGS =======================
Pages.settings = {
  title: 'Settings',
  async render(root) {
    const s = await api('/api/settings');
    const isAdmin = State.user.role === 'Administrator';
    const cell = (bt, pm) => {
      const cents = (s.pricing[bt] || {})[pm] || 0;
      return `<td><input type="number" step="0.01" min="0" data-bt="${esc(bt)}" data-pm="${esc(pm)}" value="${(cents / 100).toFixed(2)}" ${isAdmin ? '' : 'disabled'} style="width:120px;text-align:right"></td>`;
    };
    root.innerHTML = `
      <div class="panel"><div class="panel-head"><h3>Burial Pricing Table</h3>${isAdmin ? '<button class="btn btn-primary btn-sm" id="st-save">Save Pricing</button>' : ''}</div><div class="panel-body">
        <p class="muted" style="margin-top:0">Prices apply to <b>new records</b> and to records explicitly recalculated on edit. Existing saved records always keep their stored Total Amount — updating this table never silently changes historical records.</p>
        <table class="grid"><thead><tr><th>Burial Type</th><th class="num">Installment</th><th class="num">Full Payment (Cash)</th></tr></thead><tbody>
          ${BURIAL_TYPES.map(bt => `<tr><td>${bt}</td>${cell(bt, 'Installment')}${cell(bt, 'Full Payment (Cash)')}</tr>`).join('')}
        </tbody></table>
        <p style="margin-top:8px;font-size:12.5px" class="muted">Indigent records are always 0.00 regardless of these prices.</p>
      </div></div>
      <div class="panel"><div class="panel-head"><h3>Application Information</h3></div><div class="panel-body">
        <div class="detail-list">
          <div><div class="k">Application</div><div class="v">MPDO Cemetery Record System</div></div>
          <div><div class="k">Mode</div><div class="v">Fully offline · Local SQLite</div></div>
          <div><div class="k">Database Path</div><div class="v" style="font-size:12px;overflow-wrap:anywhere">${esc(s.db_path)}</div></div>
          <div><div class="k">Data Folder</div><div class="v" style="font-size:12px;overflow-wrap:anywhere">${esc(s.data_dir)}</div></div>
        </div>
      </div></div>
      ${isAdmin ? '<div class="panel"><div class="panel-head"><h3>Audit Trail (latest 200 actions)</h3><button class="btn btn-sm" id="st-audit-load">Load Audit Trail</button></div><div class="panel-body" id="st-audit" style="max-height:340px;overflow:auto"></div></div>' : ''}`;
    if (isAdmin) {
      $('#st-save').addEventListener('click', async () => {
        const pricing = {};
        $$('#content input[data-bt]').forEach(inp => {
          const bt = inp.dataset.bt, pm = inp.dataset.pm;
          pricing[bt] = pricing[bt] || {};
          pricing[bt][pm] = Math.round(parseFloat(inp.value || '0') * 100);
        });
        try {
          const r = await api('/api/settings/pricing', { method: 'PUT', body: JSON.stringify({ pricing }) });
          toast(r.note);
        } catch (e) { toast(e.message, 'error'); }
      });
      $('#st-audit-load').addEventListener('click', async () => {
        const d = await api('/api/audit?limit=200');
        $('#st-audit').innerHTML = `<table class="grid"><thead><tr><th>Time</th><th>User</th><th>Action</th><th>Entity</th><th>ID</th></tr></thead><tbody>
          ${d.entries.map(a => `<tr><td style="white-space:nowrap">${new Date(a.ts).toLocaleString()}</td><td>${esc(a.username)}</td><td>${esc(a.action)}</td><td>${esc(a.entity) || ''}</td><td>${esc(a.entity_id) || ''}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">No entries.</td></tr>'}</tbody></table>`;
      });
    }
  },
};

// start
if (State.token === null && location.hash) location.hash = '';
