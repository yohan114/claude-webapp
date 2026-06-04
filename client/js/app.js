// ============================================================ utilities
const api = {
  async get(url) { const r = await fetch(url); if (!r.ok) throw new Error((await r.json()).error || r.status); return r.json(); },
  async send(url, method, body) {
    const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error((await r.json()).error || r.status); return r.json();
  },
};
const el = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
const esc = (s) => (s == null ? '' : String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])));
const fmtDate = (s) => (s ? s : '');
const money = (n) => (n == null ? '' : 'Rs ' + Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 }));
const num = (n) => (n == null ? '' : Number(n).toLocaleString());

function toast(msg, kind = '') {
  const t = document.getElementById('toast');
  t.textContent = msg; t.className = 'toast show ' + kind;
  setTimeout(() => (t.className = 'toast'), 2200);
}

// ------------------------------------------------------------ modal + form
function modal({ title, fields, values = {}, onSave }) {
  const root = document.getElementById('modal-root');
  const inputs = fields.map((f) => {
    const v = values[f.name] ?? f.default ?? '';
    const wide = f.full ? 'full' : '';
    if (f.type === 'select') {
      const opts = f.options.map((o) => `<option value="${esc(o)}" ${o === v ? 'selected' : ''}>${esc(o)}</option>`).join('');
      return `<div class="field ${wide}"><label>${esc(f.label)}</label><select name="${f.name}">${opts}</select></div>`;
    }
    if (f.type === 'textarea') {
      return `<div class="field ${wide}"><label>${esc(f.label)}</label><textarea name="${f.name}" rows="3">${esc(v)}</textarea></div>`;
    }
    const list = f.datalist ? `list="dl-${f.name}"` : '';
    const dl = f.datalist ? `<datalist id="dl-${f.name}">${f.datalist.map((o) => `<option value="${esc(o)}">`).join('')}</datalist>` : '';
    return `<div class="field ${wide}"><label>${esc(f.label)}</label><input name="${f.name}" type="${f.type || 'text'}" value="${esc(v)}" ${list} ${f.readonly ? 'readonly' : ''} />${dl}</div>`;
  }).join('');
  const bg = el(`<div class="modal-bg"><div class="modal">
    <div class="modal-head"><h3>${esc(title)}</h3><button class="close">×</button></div>
    <form class="modal-body">${inputs}</form>
    <div class="modal-foot"><button class="btn ghost" data-act="cancel">Cancel</button><button class="btn" data-act="save">Save</button></div>
  </div></div>`);
  const close = () => root.innerHTML = '';
  bg.querySelector('.close').onclick = close;
  bg.querySelector('[data-act="cancel"]').onclick = close;
  bg.onclick = (e) => { if (e.target === bg) close(); };
  bg.querySelector('[data-act="save"]').onclick = async () => {
    const form = bg.querySelector('form');
    const data = {};
    fields.forEach((f) => { let val = form.elements[f.name].value; if (f.numeric) val = val === '' ? null : Number(val); data[f.name] = val === '' ? null : val; });
    try { await onSave(data); close(); } catch (e) { toast(e.message, 'err'); }
  };
  root.innerHTML = ''; root.appendChild(bg);
  setTimeout(() => { const fst = bg.querySelector('input:not([readonly]), select, textarea'); fst && fst.focus(); }, 30);
}

function confirmDelete(label, onYes) {
  if (confirm(`Delete ${label}?`)) onYes();
}

// ------------------------------------------------------------ table render
function renderTable(cols, rows, { actions } = {}) {
  if (!rows.length) return '<div class="empty">No records found.</div>';
  const head = cols.map((c) => `<th data-key="${c.key}">${esc(c.label)}</th>`).join('') + (actions ? '<th></th>' : '');
  const body = rows.map((r, i) => {
    const tds = cols.map((c) => `<td>${c.render ? c.render(r[c.key], r) : esc(r[c.key])}</td>`).join('');
    const act = actions ? `<td class="actions">
      <button class="btn ghost sm" data-edit="${i}">Edit</button>
      <button class="btn danger sm" data-del="${i}">Del</button></td>` : '';
    return `<tr>${tds}${act}</tr>`;
  }).join('');
  return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

// client-side sort helper
function attachSort(container, cols, rows, rerender) {
  container.querySelectorAll('th[data-key]').forEach((th) => {
    th.onclick = () => {
      const key = th.dataset.key;
      const dir = th._dir = th._dir === 'asc' ? 'desc' : 'asc';
      rows.sort((a, b) => {
        const x = a[key], y = b[key];
        if (x == null) return 1; if (y == null) return -1;
        const cmp = (typeof x === 'number' && typeof y === 'number') ? x - y : String(x).localeCompare(String(y));
        return dir === 'asc' ? cmp : -cmp;
      });
      rerender();
    };
  });
}

// ============================================================ state
const state = { route: 'dashboard', search: '', vehicles: [], sites: [] };
const view = document.getElementById('view');

async function loadLookups() {
  try {
    const fleet = await api.get('/api/fleet');
    state.vehicles = [...new Set(fleet.map((f) => f.reg_no).filter(Boolean))];
    state.sites = await api.get('/api/fleet/sites');
  } catch (e) { /* ignore */ }
}

// ============================================================ VIEWS
const views = {};

// ---------------- Dashboard
views.dashboard = async () => {
  view.innerHTML = '<div class="loading">Loading…</div>';
  const d = await api.get('/api/dashboard');
  const s = d.stats;
  const stat = (v, l) => `<div class="stat"><div class="v">${v}</div><div class="l">${l}</div></div>`;
  const maxCat = Math.max(1, ...d.byCategory.map((c) => c.c));
  const maxSite = Math.max(1, ...d.bySite.map((c) => c.c));
  const bars = (arr, max, labKey, valKey) => arr.map((r) =>
    `<div class="bar-row"><div class="lab">${esc(r[labKey] || '—')}</div>
      <div class="bar-track"><div class="bar-fill" style="width:${(r[valKey] / max) * 100}%"></div></div>
      <div class="val">${num(r[valKey])}</div></div>`).join('');
  view.innerHTML = `
    <div class="stat-grid">
      ${stat(s.totalJobs, 'Total Jobs')}
      ${stat(s.openJobs, 'Open Jobs')}
      ${stat(s.fleetCount, 'Fleet Units')}
      ${stat(num(s.materialIssues), 'Material Issues')}
      ${stat(num(Math.round(s.workLogHours)), 'Labour Man-Hours')}
      ${stat(num(s.priceItems), 'Priced Items')}
    </div>
    <div class="cols-2">
      <div class="panel"><h2>Material Issues by Category</h2>${bars(d.byCategory, maxCat, 'category', 'c')}</div>
      <div class="panel"><h2>Jobs by Site</h2>${bars(d.bySite, maxSite, 'site', 'c')}</div>
    </div>
    <div class="panel"><h2>Recent Jobs</h2>
      ${renderTable([
        { key: 'job_no', label: 'Job No', render: (v) => `<span class="link" data-job="${esc(v)}">${esc(v)}</span>` },
        { key: 'vehicle', label: 'Vehicle' },
        { key: 'description', label: 'Description' },
        { key: 'site', label: 'Site' },
        { key: 'end_date', label: 'Status', render: (v) => v ? '<span class="badge closed">Closed</span>' : '<span class="badge open">Open</span>' },
      ], d.recentJobs)}
    </div>`;
  view.querySelectorAll('[data-job]').forEach((a) => a.onclick = () => openJobReport(a.dataset.job));
};

// ---------------- Jobs
views.jobs = async () => {
  view.innerHTML = `<div class="toolbar">
    <div class="chip active" data-status="">All</div>
    <div class="chip" data-status="open">Open</div>
    <div class="chip" data-status="closed">Closed</div>
    <div class="grow"></div>
    <button class="btn" id="add">+ New Job</button>
  </div><div id="tbl"><div class="loading">Loading…</div></div>`;
  let status = '';
  const tbl = view.querySelector('#tbl');
  const cols = [
    { key: 'job_no', label: 'Job No', render: (v) => `<span class="link" data-rep="${esc(v)}">${esc(v)}</span>` },
    { key: 'vehicle', label: 'Vehicle' },
    { key: 'description', label: 'Description' },
    { key: 'start_date', label: 'Start' },
    { key: 'end_date', label: 'End', render: (v) => v || '<span class="badge open">Open</span>' },
    { key: 'site', label: 'Site' },
  ];
  const fields = [
    { name: 'job_no', label: 'Job No (auto)', readonly: true },
    { name: 'ref', label: 'Ref' },
    { name: 'vehicle', label: 'Vehicle', datalist: state.vehicles },
    { name: 'site', label: 'Site', datalist: state.sites },
    { name: 'start_date', label: 'Start Date', type: 'date' },
    { name: 'end_date', label: 'End Date', type: 'date' },
    { name: 'description', label: 'Description', type: 'textarea', full: true },
    { name: 'remarks', label: 'Remarks', type: 'textarea', full: true },
  ];
  async function load() {
    const rows = await api.get(`/api/jobs?status=${status}&q=${encodeURIComponent(state.search)}`);
    const draw = () => {
      tbl.innerHTML = renderTable(cols, rows, { actions: true });
      attachSort(tbl, cols, rows, draw);
      tbl.querySelectorAll('[data-rep]').forEach((a) => a.onclick = () => openJobReport(a.dataset.rep));
      tbl.querySelectorAll('[data-edit]').forEach((b) => b.onclick = () => {
        const r = rows[+b.dataset.edit];
        modal({ title: 'Edit Job ' + r.job_no, fields, values: r, onSave: async (data) => { await api.send('/api/jobs/' + r.id, 'PUT', data); toast('Saved', 'ok'); load(); } });
      });
      tbl.querySelectorAll('[data-del]').forEach((b) => b.onclick = () => {
        const r = rows[+b.dataset.del];
        confirmDelete('job ' + r.job_no, async () => { await api.send('/api/jobs/' + r.id, 'DELETE'); toast('Deleted', 'ok'); load(); });
      });
    };
    draw();
  }
  view.querySelectorAll('.chip').forEach((c) => c.onclick = () => {
    view.querySelectorAll('.chip').forEach((x) => x.classList.remove('active'));
    c.classList.add('active'); status = c.dataset.status; load();
  });
  view.querySelector('#add').onclick = async () => {
    const { job_no } = await api.get('/api/jobs/next-no');
    modal({ title: 'New Job', fields, values: { job_no, start_date: new Date().toISOString().slice(0, 10) },
      onSave: async (data) => { await api.send('/api/jobs', 'POST', data); toast('Job created', 'ok'); load(); } });
  };
  view._reload = load;
  load();
};

// ---------------- Fleet
views.fleet = async () => {
  view.innerHTML = `<div class="toolbar">
    <select id="site" class="search" style="width:200px"><option value="">All sites</option>${state.sites.map((s) => `<option>${esc(s)}</option>`).join('')}</select>
  </div><div id="tbl"><div class="loading">Loading…</div></div>`;
  const tbl = view.querySelector('#tbl');
  const cols = [
    { key: 'no', label: '#' },
    { key: 'reg_no', label: 'Reg No', render: (v) => `<span class="link" data-veh="${esc(v)}">${esc(v)}</span>` },
    { key: 'ec_number', label: 'E&C No' },
    { key: 'description', label: 'Equipment' },
    { key: 'brand', label: 'Brand' },
    { key: 'type', label: 'Type' },
    { key: 'site', label: 'Site' },
  ];
  async function load() {
    const site = view.querySelector('#site').value;
    const rows = await api.get(`/api/fleet?q=${encodeURIComponent(state.search)}&site=${encodeURIComponent(site)}`);
    const draw = () => {
      tbl.innerHTML = renderTable(cols, rows);
      attachSort(tbl, cols, rows, draw);
      tbl.querySelectorAll('[data-veh]').forEach((a) => a.onclick = () => openVehicle(a.dataset.veh));
    };
    draw();
  }
  view.querySelector('#site').onchange = load;
  view._reload = load;
  load();
};

// ---------------- Materials
const MAT_CATS = ['Battery', 'Filter', 'Lubricant', 'General', 'Tyre', 'MRN'];
views.materials = async () => {
  view.innerHTML = `<div class="toolbar">
    ${MAT_CATS.map((c, i) => `<div class="chip ${i === 0 ? 'active' : ''}" data-cat="${c}">${c}</div>`).join('')}
    <div class="grow"></div>
    <select id="used" class="search" style="width:160px">
      <option value="">All materials</option>
      <option value="yes">✔ Used (in a job)</option>
      <option value="no">○ Not used</option>
    </select>
    <button class="btn" id="add">+ Issue Material</button>
  </div><div id="tbl"><div class="loading">Loading…</div></div>`;
  let cat = 'Battery';
  const tbl = view.querySelector('#tbl');
  const cols = [
    { key: 'date', label: 'Date' },
    { key: 'mr_no', label: 'MR No' },
    { key: 'description', label: 'Description' },
    { key: 'qty', label: 'Qty', render: num },
    { key: 'unit_price', label: 'Unit Price', render: money },
    { key: 'line_total', label: 'Total', render: money },
    { key: 'vehicle', label: 'Vehicle', render: (v) => v ? `<span class="link" data-veh="${esc(v)}">${esc(v)}</span>` : '' },
    { key: 'job_no', label: 'Used in Job', render: (v) => v
        ? `<span class="badge closed" title="Assigned to job by date range">✔</span> <span class="link" data-rep="${esc(v)}">${esc(v)}</span>`
        : '<span class="badge open" title="Not within any job date range">○ unused</span>' },
  ];
  const fields = () => [
    { name: 'category', label: 'Category', type: 'select', options: MAT_CATS, default: cat },
    { name: 'date', label: 'Date', type: 'date', default: new Date().toISOString().slice(0, 10) },
    { name: 'mr_no', label: 'MR / MRN No' },
    { name: 'qty', label: 'Qty', type: 'number', numeric: true },
    { name: 'vehicle', label: 'Vehicle', datalist: state.vehicles },
    { name: 'unit', label: 'Unit' },
    { name: 'description', label: 'Description', type: 'textarea', full: true },
    { name: 'remarks', label: 'Remarks / Site', full: true },
  ];
  async function load() {
    const used = view.querySelector('#used').value;
    const rows = await api.get(`/api/materials?category=${cat}&used=${used}&q=${encodeURIComponent(state.search)}`);
    const draw = () => {
      tbl.innerHTML = renderTable(cols, rows, { actions: true });
      attachSort(tbl, cols, rows, draw);
      tbl.querySelectorAll('[data-veh]').forEach((a) => a.onclick = () => openVehicle(a.dataset.veh));
      tbl.querySelectorAll('[data-rep]').forEach((a) => a.onclick = () => openJobReport(a.dataset.rep));
      tbl.querySelectorAll('[data-edit]').forEach((b) => b.onclick = () => {
        const r = rows[+b.dataset.edit];
        modal({ title: 'Edit Material', fields: fields(), values: r, onSave: async (data) => { await api.send('/api/materials/' + r.id, 'PUT', data); toast('Saved', 'ok'); load(); } });
      });
      tbl.querySelectorAll('[data-del]').forEach((b) => b.onclick = () => {
        const r = rows[+b.dataset.del];
        confirmDelete('this material', async () => { await api.send('/api/materials/' + r.id, 'DELETE'); toast('Deleted', 'ok'); load(); });
      });
    };
    draw();
  }
  view.querySelector('#used').onchange = load;
  view.querySelectorAll('.chip').forEach((c) => c.onclick = () => {
    view.querySelectorAll('.chip').forEach((x) => x.classList.remove('active'));
    c.classList.add('active'); cat = c.dataset.cat; load();
  });
  view.querySelector('#add').onclick = () => modal({ title: 'Issue Material', fields: fields(),
    onSave: async (data) => { await api.send('/api/materials', 'POST', data); toast('Issued', 'ok'); load(); } });
  view._reload = load;
  load();
};

// ---------------- Work Log
views.worklog = async () => {
  view.innerHTML = `<div class="toolbar">
    <input id="from" type="date" class="search" style="width:160px" />
    <input id="to" type="date" class="search" style="width:160px" />
    <div class="grow"></div>
    <button class="btn" id="add">+ Log Work</button>
  </div><div id="tbl"><div class="loading">Loading…</div></div>`;
  const tbl = view.querySelector('#tbl');
  const cols = [
    { key: 'date', label: 'Date' },
    { key: 'vehicle', label: 'Vehicle', render: (v) => v ? `<span class="link" data-veh="${esc(v)}">${esc(v)}</span>` : '' },
    { key: 'description', label: 'Work Done' },
    { key: 'mechanic', label: 'Mechanic(s)' },
    { key: 'hours', label: 'Hrs', render: num },
    { key: 'man_hours', label: 'Man-Hrs', render: num },
    { key: 'job_no', label: 'Job', render: (v) => v ? `<span class="link" data-rep="${esc(v)}">${esc(v)}</span>` : '<span class="muted">—</span>' },
  ];
  const fields = [
    { name: 'date', label: 'Date', type: 'date', default: new Date().toISOString().slice(0, 10) },
    { name: 'vehicle', label: 'Vehicle', datalist: state.vehicles },
    { name: 'hours', label: 'Hours', type: 'number', numeric: true },
    { name: 'mechanic', label: 'Mechanic(s) — comma separated' },
    { name: 'description', label: 'Work Done', type: 'textarea', full: true },
    { name: 'remarks', label: 'Remarks', full: true },
  ];
  async function load() {
    const from = view.querySelector('#from').value, to = view.querySelector('#to').value;
    const rows = await api.get(`/api/worklog?q=${encodeURIComponent(state.search)}&from=${from}&to=${to}`);
    const draw = () => {
      tbl.innerHTML = renderTable(cols, rows, { actions: true });
      attachSort(tbl, cols, rows, draw);
      tbl.querySelectorAll('[data-veh]').forEach((a) => a.onclick = () => openVehicle(a.dataset.veh));
      tbl.querySelectorAll('[data-rep]').forEach((a) => a.onclick = () => openJobReport(a.dataset.rep));
      tbl.querySelectorAll('[data-edit]').forEach((b) => b.onclick = () => {
        const r = rows[+b.dataset.edit];
        modal({ title: 'Edit Work Log', fields, values: r, onSave: async (data) => { await api.send('/api/worklog/' + r.id, 'PUT', data); toast('Saved', 'ok'); load(); } });
      });
      tbl.querySelectorAll('[data-del]').forEach((b) => b.onclick = () => {
        const r = rows[+b.dataset.del];
        confirmDelete('this entry', async () => { await api.send('/api/worklog/' + r.id, 'DELETE'); toast('Deleted', 'ok'); load(); });
      });
    };
    draw();
  }
  view.querySelector('#from').onchange = load;
  view.querySelector('#to').onchange = load;
  view.querySelector('#add').onclick = () => modal({ title: 'Log Work', fields,
    onSave: async (data) => { await api.send('/api/worklog', 'POST', data); toast('Logged', 'ok'); load(); } });
  view._reload = load;
  load();
};

// ---------------- Prices
views.prices = async () => {
  view.innerHTML = `<div class="toolbar"><div class="grow"></div><button class="btn" id="add">+ Add Price</button></div>
    <div id="tbl"><div class="loading">Loading…</div></div>`;
  const tbl = view.querySelector('#tbl');
  const cols = [
    { key: 'description', label: 'Description' },
    { key: 'current_price', label: 'Price', render: money },
    { key: 'purchase_type', label: 'Purchase Type' },
    { key: 'supplier', label: 'Supplier' },
    { key: 'date', label: 'Date' },
  ];
  const fields = [
    { name: 'description', label: 'Description', full: true },
    { name: 'current_price', label: 'Price', type: 'number', numeric: true },
    { name: 'purchase_type', label: 'Purchase Type' },
    { name: 'supplier', label: 'Supplier' },
    { name: 'mrn', label: 'MRN' },
    { name: 'date', label: 'Date', type: 'date' },
  ];
  async function load() {
    const rows = await api.get(`/api/prices?q=${encodeURIComponent(state.search)}`);
    const draw = () => {
      tbl.innerHTML = renderTable(cols, rows, { actions: true });
      attachSort(tbl, cols, rows, draw);
      tbl.querySelectorAll('[data-edit]').forEach((b) => b.onclick = () => {
        const r = rows[+b.dataset.edit];
        modal({ title: 'Edit Price', fields, values: r, onSave: async (data) => { await api.send('/api/prices/' + r.id, 'PUT', data); toast('Saved', 'ok'); load(); } });
      });
      tbl.querySelectorAll('[data-del]').forEach((b) => b.onclick = () => {
        const r = rows[+b.dataset.del];
        confirmDelete('this price', async () => { await api.send('/api/prices/' + r.id, 'DELETE'); toast('Deleted', 'ok'); load(); });
      });
    };
    draw();
  }
  view.querySelector('#add').onclick = () => modal({ title: 'Add Price', fields,
    onSave: async (data) => { await api.send('/api/prices', 'POST', data); toast('Added', 'ok'); load(); } });
  view._reload = load;
  load();
};

// ---------------- Reports
views.reports = async () => {
  view.innerHTML = `
    <div class="panel"><h2>Job Cost Summary</h2>
      <div class="toolbar"><input id="jobno" class="search" placeholder="Enter Job No (e.g. 2026/1/R/001)" style="width:320px" />
      <button class="btn" id="run">Generate</button></div>
      <div id="jobreport"></div>
    </div>
    <div class="cols-2">
      <div class="panel"><h2>Monthly Labour Hours</h2><div id="labour" class="loading">Loading…</div></div>
      <div class="panel"><h2>Pending MRN / Tyre Requests</h2><div id="pending" class="loading">Loading…</div></div>
    </div>`;
  const run = () => { const j = view.querySelector('#jobno').value.trim(); if (j) openJobReport(j, view.querySelector('#jobreport')); };
  view.querySelector('#run').onclick = run;
  view.querySelector('#jobno').onkeydown = (e) => { if (e.key === 'Enter') run(); };

  api.get('/api/report/labour-monthly').then((rows) => {
    view.querySelector('#labour').outerHTML = '<div id="labour">' + renderTable([
      { key: 'month', label: 'Month' }, { key: 'mechanic', label: 'Mechanic' }, { key: 'hours', label: 'Man-Hrs', render: num },
    ], rows.slice(0, 100)) + '</div>';
  });
  api.get('/api/report/pending-mrn').then((rows) => {
    view.querySelector('#pending').outerHTML = '<div id="pending">' + renderTable([
      { key: 'date', label: 'Date' }, { key: 'mr_no', label: 'MR No' }, { key: 'description', label: 'Item' },
      { key: 'qty', label: 'Qty', render: num }, { key: 'vehicle', label: 'Vehicle' },
    ], rows.slice(0, 100)) + '</div>';
  });
};

// ============================================================ detail panels
async function openJobReport(jobNo, target) {
  const dest = target || view;
  if (!target) { setRoute('reports'); await new Promise((r) => setTimeout(r, 50)); }
  const box = target || view.querySelector('#jobreport') || view;
  box.innerHTML = '<div class="loading">Loading job…</div>';
  try {
    const d = await api.get('/api/report/job/' + encodeURIComponent(jobNo));
    const j = d.job, s = d.summary;
    box.innerHTML = `
      <div class="stat-grid" style="margin-top:14px">
        <div class="stat"><div class="v">${esc(j.vehicle || '—')}</div><div class="l">Vehicle</div></div>
        <div class="stat"><div class="v">${money(s.materialCost) || 'Rs 0'}</div><div class="l">Material Cost</div></div>
        <div class="stat"><div class="v">${num(Math.round(s.labourHours))}</div><div class="l">Labour Man-Hrs</div></div>
        <div class="stat"><div class="v">${esc(j.site || '—')}</div><div class="l">Site</div></div>
      </div>
      <p class="muted">${esc(j.description || '')} · ${esc(j.start_date || '')} → ${esc(j.end_date || 'Open')}</p>
      <h2 style="font-size:14px">Materials (${d.materials.length})</h2>
      ${renderTable([
        { key: 'date', label: 'Date' }, { key: 'category', label: 'Cat' }, { key: 'description', label: 'Item' },
        { key: 'qty', label: 'Qty', render: num }, { key: 'unit_price', label: 'Unit', render: money }, { key: 'line_total', label: 'Total', render: money },
      ], d.materials)}
      <h2 style="font-size:14px;margin-top:18px">Labour (${d.work.length})</h2>
      ${renderTable([
        { key: 'date', label: 'Date' }, { key: 'description', label: 'Work' }, { key: 'mechanic', label: 'Mechanic' }, { key: 'man_hours', label: 'Man-Hrs', render: num },
      ], d.work)}`;
  } catch (e) { box.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}

async function openVehicle(reg) {
  const d = await api.get('/api/vehicle/' + encodeURIComponent(reg));
  const v = d.vehicle || {};
  const root = document.getElementById('modal-root');
  const bg = el(`<div class="modal-bg"><div class="modal" style="width:760px">
    <div class="modal-head"><h3>🚚 ${esc(reg)}</h3><button class="close">×</button></div>
    <div class="modal-body" style="display:block">
      <p class="muted">${esc(v.description || '')} ${v.brand ? '· ' + esc(v.brand) : ''} ${v.site ? '· ' + esc(v.site) : ''}</p>
      <h2 style="font-size:13px">Jobs (${d.jobs.length})</h2>
      ${renderTable([{ key: 'job_no', label: 'Job' }, { key: 'description', label: 'Desc' }, { key: 'start_date', label: 'Start' }, { key: 'end_date', label: 'End' }], d.jobs.slice(0, 20))}
      <h2 style="font-size:13px;margin-top:14px">Materials (${d.materials.length})</h2>
      ${renderTable([{ key: 'date', label: 'Date' }, { key: 'category', label: 'Cat' }, { key: 'description', label: 'Item' }, { key: 'qty', label: 'Qty', render: num }], d.materials.slice(0, 20))}
      <h2 style="font-size:13px;margin-top:14px">Work Log (${d.work.length})</h2>
      ${renderTable([{ key: 'date', label: 'Date' }, { key: 'description', label: 'Work' }, { key: 'man_hours', label: 'Man-Hrs', render: num }], d.work.slice(0, 20))}
    </div></div></div>`);
  bg.querySelector('.close').onclick = () => root.innerHTML = '';
  bg.onclick = (e) => { if (e.target === bg) root.innerHTML = ''; };
  root.innerHTML = ''; root.appendChild(bg);
}

// ============================================================ router
const TITLES = { dashboard: 'Dashboard', jobs: 'Jobs', fleet: 'Fleet', materials: 'Materials', worklog: 'Work Log', prices: 'Prices', reports: 'Reports' };
function setRoute(route) {
  if (!views[route]) route = 'dashboard';
  state.route = route; state.search = '';
  document.getElementById('global-search').value = '';
  document.getElementById('page-title').textContent = TITLES[route];
  document.querySelectorAll('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.route === route));
  location.hash = route;
  views[route]();
}
document.getElementById('nav').addEventListener('click', (e) => {
  const a = e.target.closest('.nav-item'); if (a) { e.preventDefault(); setRoute(a.dataset.route); }
});

// global search → debounced reload of current view
let searchT;
const searchInput = document.getElementById('global-search');
searchInput.addEventListener('input', (e) => {
  state.search = e.target.value;
  clearTimeout(searchT);
  searchT = setTimeout(() => { if (view._reload) view._reload(); else if (state.route === 'dashboard') {} }, 250);
});

// keyboard shortcuts
document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea, select')) { if (e.key === 'Escape') e.target.blur(); return; }
  if (e.key === '/') { e.preventDefault(); searchInput.focus(); }
  if (e.key.toLowerCase() === 'n') { const add = view.querySelector('#add'); if (add) { e.preventDefault(); add.click(); } }
  if (e.key === 'Escape') document.getElementById('modal-root').innerHTML = '';
});

// boot
(async () => {
  await loadLookups();
  setRoute(location.hash.replace('#', '') || 'dashboard');
})();
