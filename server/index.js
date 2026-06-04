import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { db, initSchema } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

initSchema();

// ---------------------------------------------------------------- helpers
const ok = (res, data) => res.json(data);
const fail = (res, e) => res.status(400).json({ error: String(e.message || e) });

// generic LIKE search builder
function likeWhere(fields, q) {
  if (!q) return { sql: '', params: [] };
  const sql = ' WHERE ' + fields.map((f) => `${f} LIKE ?`).join(' OR ');
  return { sql, params: fields.map(() => `%${q}%`) };
}

// Correlated subquery: auto-match a row (alias `t`, columns vehicle & date) to a job
// whose vehicle matches and whose date window (start .. end-or-today) contains the row date.
const JOB_MATCH = (t) => `(SELECT j.job_no FROM jobs j
  WHERE j.vehicle = ${t}.vehicle
    AND ${t}.date IS NOT NULL AND ${t}.date != ''
    AND j.start_date IS NOT NULL
    AND ${t}.date >= j.start_date
    AND ${t}.date <= COALESCE(NULLIF(j.end_date,''), date('now'))
  ORDER BY j.start_date DESC LIMIT 1)`;

// Correlated subquery: latest price for a row's description (alias `t`).
const PRICE_MATCH = (t) => `(SELECT p.current_price FROM prices p
  WHERE p.description = ${t}.description ORDER BY p.id DESC LIMIT 1)`;

// ---------------------------------------------------------------- labour
const normName = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
function lev(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[m][n];
}
// split a "Mechanic" cell into individual people (commas / dots / slashes separate them)
const splitMechanics = (field) => String(field || '').split(/[,/.]+/).map((s) => s.trim()).filter(Boolean);

// Build alias table from labour_rates; "X/Y" rate names yield multiple aliases.
function loadAliases() {
  const rows = db.prepare('SELECT name, hour_price FROM labour_rates').all();
  const aliases = [];
  for (const r of rows) for (const part of r.name.split('/')) {
    const key = normName(part); if (key) aliases.push({ key, name: r.name, rate: r.hour_price });
  }
  return aliases;
}
// Resolve a single token to a canonical rate via exact-then-fuzzy match.
function matchOne(token, aliases) {
  const k = normName(token);
  if (!k) return null;
  let best = null, bestD = 99;
  for (const a of aliases) {
    if (a.key === k) return a;
    const d = lev(k, a.key);
    if (d < bestD) { bestD = d; best = a; }
  }
  const tol = k.length <= 4 ? 1 : 2;       // shorter names need a tighter tolerance
  return bestD <= tol ? best : null;
}
// Expand a "Mechanic" cell into a list of resolved people. Tries the whole token
// first (so "Vinod M" stays one person), then falls back to splitting on spaces
// (so "Buddika Viboda" / "Nuwan Nimesh" become two people).
function resolvePeople(field, aliases) {
  const people = [];
  for (const tok of splitMechanics(field)) {
    const whole = matchOne(tok, aliases);
    if (whole) { people.push({ name: whole.name, rate: whole.rate, matched: true }); continue; }
    const parts = tok.split(/\s+/).filter(Boolean);
    if (parts.length > 1) {
      const resolved = parts.map((p) => matchOne(p, aliases));
      if (resolved.some(Boolean)) {
        resolved.forEach((r, i) => people.push(r ? { name: r.name, rate: r.rate, matched: true }
          : { name: parts[i], rate: 0, matched: false }));
        continue;
      }
    }
    people.push({ name: tok, rate: 0, matched: false });
  }
  return people;
}
// Compute labour cost + per-mechanic breakdown for a set of daily_work rows.
// Rule (user choice): each listed mechanic is credited the full H hours of the row.
function computeLabour(workRows, aliases) {
  let cost = 0, hours = 0, unmatched = 0;
  const perMech = new Map();
  for (const w of workRows) {
    const h = Number(w.hours) || 0;
    if (!h) continue;
    for (const p of resolvePeople(w.mechanic, aliases)) {
      const lineCost = h * p.rate;
      hours += h; cost += lineCost;
      if (!p.matched) unmatched += h;
      const cur = perMech.get(p.name) || { name: p.name, hours: 0, cost: 0, rate: p.rate, matched: p.matched };
      cur.hours += h; cur.cost += lineCost; perMech.set(p.name, cur);
    }
  }
  return { cost, hours, unmatchedHours: unmatched, perMechanic: [...perMech.values()].sort((x, y) => y.cost - x.cost) };
}

// ============================================================ DASHBOARD
app.get('/api/dashboard', (req, res) => {
  try {
    const stats = {
      totalJobs: db.prepare('SELECT COUNT(*) c FROM jobs').get().c,
      openJobs: db.prepare("SELECT COUNT(*) c FROM jobs WHERE end_date IS NULL OR end_date=''").get().c,
      fleetCount: db.prepare('SELECT COUNT(*) c FROM fleet').get().c,
      materialIssues: db.prepare('SELECT COUNT(*) c FROM material_issues').get().c,
      workLogHours: db.prepare('SELECT COALESCE(SUM(man_hours),0) s FROM daily_work').get().s,
      priceItems: db.prepare('SELECT COUNT(*) c FROM prices').get().c,
    };
    const recentJobs = db.prepare('SELECT job_no, vehicle, description, start_date, end_date, site FROM jobs ORDER BY id DESC LIMIT 8').all();
    const byCategory = db.prepare('SELECT category, COUNT(*) c, COALESCE(SUM(qty),0) qty FROM material_issues GROUP BY category ORDER BY c DESC').all();
    const bySite = db.prepare("SELECT COALESCE(NULLIF(site,''),'(none)') site, COUNT(*) c FROM jobs GROUP BY site ORDER BY c DESC LIMIT 8").all();
    ok(res, { stats, recentJobs, byCategory, bySite });
  } catch (e) { fail(res, e); }
});

// ============================================================ FLEET
app.get('/api/fleet', (req, res) => {
  try {
    const { q, site } = req.query;
    let sql = 'SELECT * FROM fleet';
    const params = [];
    const clauses = [];
    if (q) { clauses.push('(reg_no LIKE ? OR ec_number LIKE ? OR description LIKE ? OR brand LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`); }
    if (site) { clauses.push('site = ?'); params.push(site); }
    if (clauses.length) sql += ' WHERE ' + clauses.join(' AND ');
    sql += ' ORDER BY no LIMIT 1000';
    ok(res, db.prepare(sql).all(...params));
  } catch (e) { fail(res, e); }
});

app.get('/api/fleet/sites', (req, res) => {
  try { ok(res, db.prepare("SELECT DISTINCT site FROM fleet WHERE site IS NOT NULL AND site!='' ORDER BY site").all().map((r) => r.site)); }
  catch (e) { fail(res, e); }
});

// vehicle 360: jobs + materials + work for one vehicle
app.get('/api/vehicle/:reg', (req, res) => {
  try {
    const reg = req.params.reg;
    ok(res, {
      vehicle: db.prepare('SELECT * FROM fleet WHERE reg_no = ? OR ec_number = ?').get(reg, reg),
      jobs: db.prepare('SELECT * FROM jobs WHERE vehicle = ? ORDER BY start_date DESC').all(reg),
      materials: db.prepare('SELECT * FROM material_issues WHERE vehicle = ? ORDER BY date DESC').all(reg),
      work: db.prepare('SELECT * FROM daily_work WHERE vehicle = ? ORDER BY date DESC').all(reg),
    });
  } catch (e) { fail(res, e); }
});

// ============================================================ JOBS
app.get('/api/jobs', (req, res) => {
  try {
    const { q, status } = req.query;
    let sql = 'SELECT * FROM jobs';
    const params = [];
    const clauses = [];
    if (q) { clauses.push('(job_no LIKE ? OR vehicle LIKE ? OR description LIKE ? OR site LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`); }
    if (status === 'open') clauses.push("(end_date IS NULL OR end_date='')");
    if (status === 'closed') clauses.push("(end_date IS NOT NULL AND end_date!='')");
    if (clauses.length) sql += ' WHERE ' + clauses.join(' AND ');
    sql += ' ORDER BY id DESC LIMIT 2000';
    ok(res, db.prepare(sql).all(...params));
  } catch (e) { fail(res, e); }
});

// auto next job no: YYYY/M/R/NNN
function nextJobNo() {
  const now = new Date();
  const prefix = `${now.getFullYear()}/${now.getMonth() + 1}/R/`;
  const row = db.prepare("SELECT job_no FROM jobs WHERE job_no LIKE ? ORDER BY job_no DESC LIMIT 1").get(prefix + '%');
  let seq = 1;
  if (row) { const m = row.job_no.match(/(\d+)$/); if (m) seq = parseInt(m[1], 10) + 1; }
  return prefix + String(seq).padStart(3, '0');
}
app.get('/api/jobs/next-no', (req, res) => ok(res, { job_no: nextJobNo() }));

app.post('/api/jobs', (req, res) => {
  try {
    const b = req.body;
    const job_no = b.job_no || nextJobNo();
    db.prepare(`INSERT INTO jobs (job_no, ref, vehicle, description, start_date, end_date, site, cost, remarks)
      VALUES (@job_no,@ref,@vehicle,@description,@start_date,@end_date,@site,@cost,@remarks)`)
      .run({ job_no, ref: b.ref || null, vehicle: b.vehicle || null, description: b.description || null,
        start_date: b.start_date || null, end_date: b.end_date || null, site: b.site || null,
        cost: b.cost ?? null, remarks: b.remarks || null });
    ok(res, db.prepare('SELECT * FROM jobs WHERE job_no = ?').get(job_no));
  } catch (e) { fail(res, e); }
});

app.put('/api/jobs/:id', (req, res) => {
  try {
    const b = req.body;
    db.prepare(`UPDATE jobs SET ref=@ref, vehicle=@vehicle, description=@description, start_date=@start_date,
      end_date=@end_date, site=@site, cost=@cost, remarks=@remarks WHERE id=@id`)
      .run({ id: req.params.id, ref: b.ref ?? null, vehicle: b.vehicle ?? null, description: b.description ?? null,
        start_date: b.start_date ?? null, end_date: b.end_date ?? null, site: b.site ?? null, cost: b.cost ?? null, remarks: b.remarks ?? null });
    ok(res, db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id));
  } catch (e) { fail(res, e); }
});

app.delete('/api/jobs/:id', (req, res) => {
  try { db.prepare('DELETE FROM jobs WHERE id = ?').run(req.params.id); ok(res, { ok: true }); }
  catch (e) { fail(res, e); }
});

// ============================================================ MATERIAL ISSUES
app.get('/api/materials', (req, res) => {
  try {
    const { q, category, used } = req.query;
    let sql = `SELECT mi.*, ${JOB_MATCH('mi')} AS job_no, ${PRICE_MATCH('mi')} AS unit_price
      FROM material_issues mi`;
    const params = [];
    const clauses = [];
    if (category) { clauses.push('mi.category = ?'); params.push(category); }
    if (q) { clauses.push('(mi.description LIKE ? OR mi.vehicle LIKE ? OR mi.mr_no LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
    if (clauses.length) sql += ' WHERE ' + clauses.join(' AND ');
    sql += ' ORDER BY mi.id DESC LIMIT 3000';
    let rows = db.prepare(sql).all(...params);
    rows = rows.map((r) => ({ ...r, line_total: r.unit_price != null && r.qty != null ? r.unit_price * r.qty : null }));
    if (used === 'yes') rows = rows.filter((r) => r.job_no);
    if (used === 'no') rows = rows.filter((r) => !r.job_no);
    ok(res, rows);
  } catch (e) { fail(res, e); }
});

app.post('/api/materials', (req, res) => {
  try {
    const b = req.body;
    const info = db.prepare(`INSERT INTO material_issues (category, mr_no, date, description, unit, type, qty, vehicle, site, remarks)
      VALUES (@category,@mr_no,@date,@description,@unit,@type,@qty,@vehicle,@site,@remarks)`)
      .run({ category: b.category, mr_no: b.mr_no || null, date: b.date || null, description: b.description || null,
        unit: b.unit || null, type: b.type || null, qty: b.qty ?? null, vehicle: b.vehicle || null, site: b.site || null, remarks: b.remarks || null });
    ok(res, db.prepare('SELECT * FROM material_issues WHERE id = ?').get(info.lastInsertRowid));
  } catch (e) { fail(res, e); }
});

app.put('/api/materials/:id', (req, res) => {
  try {
    const b = req.body;
    db.prepare(`UPDATE material_issues SET mr_no=@mr_no, date=@date, description=@description, unit=@unit,
      type=@type, qty=@qty, vehicle=@vehicle, site=@site, remarks=@remarks WHERE id=@id`)
      .run({ id: req.params.id, mr_no: b.mr_no ?? null, date: b.date ?? null, description: b.description ?? null,
        unit: b.unit ?? null, type: b.type ?? null, qty: b.qty ?? null, vehicle: b.vehicle ?? null, site: b.site ?? null, remarks: b.remarks ?? null });
    ok(res, db.prepare('SELECT * FROM material_issues WHERE id = ?').get(req.params.id));
  } catch (e) { fail(res, e); }
});

app.delete('/api/materials/:id', (req, res) => {
  try { db.prepare('DELETE FROM material_issues WHERE id = ?').run(req.params.id); ok(res, { ok: true }); }
  catch (e) { fail(res, e); }
});

// ============================================================ DAILY WORK
function manHours(hours, mechanic) {
  const h = parseFloat(hours);
  if (isNaN(h)) return 0;
  const n = mechanic ? mechanic.split(',').filter((x) => x.trim()).length || 1 : 1;
  return h * n;
}

app.get('/api/worklog', (req, res) => {
  try {
    const { q, from, to } = req.query;
    let sql = `SELECT dw.*, ${JOB_MATCH('dw')} AS job_no FROM daily_work dw`;
    const params = [];
    const clauses = [];
    if (q) { clauses.push('(dw.vehicle LIKE ? OR dw.description LIKE ? OR dw.mechanic LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
    if (from) { clauses.push('dw.date >= ?'); params.push(from); }
    if (to) { clauses.push('dw.date <= ?'); params.push(to); }
    if (clauses.length) sql += ' WHERE ' + clauses.join(' AND ');
    sql += ' ORDER BY dw.date DESC, dw.id DESC LIMIT 3000';
    ok(res, db.prepare(sql).all(...params));
  } catch (e) { fail(res, e); }
});

app.post('/api/worklog', (req, res) => {
  try {
    const b = req.body;
    const mh = manHours(b.hours, b.mechanic);
    const info = db.prepare(`INSERT INTO daily_work (date, vehicle, description, mechanic, hours, man_hours, remarks)
      VALUES (@date,@vehicle,@description,@mechanic,@hours,@man_hours,@remarks)`)
      .run({ date: b.date || null, vehicle: b.vehicle || null, description: b.description || null,
        mechanic: b.mechanic || null, hours: b.hours ?? null, man_hours: mh, remarks: b.remarks || null });
    ok(res, db.prepare('SELECT * FROM daily_work WHERE id = ?').get(info.lastInsertRowid));
  } catch (e) { fail(res, e); }
});

app.put('/api/worklog/:id', (req, res) => {
  try {
    const b = req.body;
    const mh = manHours(b.hours, b.mechanic);
    db.prepare(`UPDATE daily_work SET date=@date, vehicle=@vehicle, description=@description, mechanic=@mechanic,
      hours=@hours, man_hours=@man_hours, remarks=@remarks WHERE id=@id`)
      .run({ id: req.params.id, date: b.date ?? null, vehicle: b.vehicle ?? null, description: b.description ?? null,
        mechanic: b.mechanic ?? null, hours: b.hours ?? null, man_hours: mh, remarks: b.remarks ?? null });
    ok(res, db.prepare('SELECT * FROM daily_work WHERE id = ?').get(req.params.id));
  } catch (e) { fail(res, e); }
});

app.delete('/api/worklog/:id', (req, res) => {
  try { db.prepare('DELETE FROM daily_work WHERE id = ?').run(req.params.id); ok(res, { ok: true }); }
  catch (e) { fail(res, e); }
});

// ============================================================ LABOUR RATES
app.get('/api/labour/rates', (req, res) => {
  try { ok(res, db.prepare('SELECT * FROM labour_rates ORDER BY name').all()); } catch (e) { fail(res, e); }
});
app.post('/api/labour/rates', (req, res) => {
  try {
    const { name, hour_price } = req.body;
    const info = db.prepare('INSERT INTO labour_rates (name, hour_price) VALUES (?,?)').run(name, hour_price ?? null);
    ok(res, db.prepare('SELECT * FROM labour_rates WHERE id = ?').get(info.lastInsertRowid));
  } catch (e) { fail(res, e); }
});
app.put('/api/labour/rates/:id', (req, res) => {
  try {
    const { name, hour_price } = req.body;
    db.prepare('UPDATE labour_rates SET name=?, hour_price=? WHERE id=?').run(name, hour_price ?? null, req.params.id);
    ok(res, db.prepare('SELECT * FROM labour_rates WHERE id = ?').get(req.params.id));
  } catch (e) { fail(res, e); }
});
app.delete('/api/labour/rates/:id', (req, res) => {
  try { db.prepare('DELETE FROM labour_rates WHERE id = ?').run(req.params.id); ok(res, { ok: true }); }
  catch (e) { fail(res, e); }
});

// Per-labourer monthly hours + cost matrix
app.get('/api/report/labour-cost', (req, res) => {
  try {
    const { from, to } = req.query;
    const aliases = loadAliases();
    let sql = "SELECT date, hours, mechanic FROM daily_work WHERE date IS NOT NULL AND date != '' AND hours IS NOT NULL";
    const params = [];
    if (from) { sql += ' AND date >= ?'; params.push(from); }
    if (to) { sql += ' AND date <= ?'; params.push(to); }
    const rows = db.prepare(sql).all(...params);

    const months = new Set();
    const byMech = new Map(); // name -> { name, rate, matched, total:{hours,cost}, months:{ 'YYYY-MM': {hours,cost} } }
    for (const w of rows) {
      const month = String(w.date).slice(0, 7);
      const h = Number(w.hours) || 0; if (!h) continue;
      months.add(month);
      for (const p of resolvePeople(w.mechanic, aliases)) {
        const cost = h * p.rate;
        let e = byMech.get(p.name);
        if (!e) { e = { name: p.name, rate: p.rate, matched: p.matched, total: { hours: 0, cost: 0 }, months: {} }; byMech.set(p.name, e); }
        e.total.hours += h; e.total.cost += cost;
        const m = e.months[month] || { hours: 0, cost: 0 };
        m.hours += h; m.cost += cost; e.months[month] = m;
      }
    }
    const monthList = [...months].sort();
    const labourers = [...byMech.values()].sort((a, b) => b.total.cost - a.total.cost);
    const grand = labourers.reduce((s, l) => ({ hours: s.hours + l.total.hours, cost: s.cost + l.total.cost }), { hours: 0, cost: 0 });
    ok(res, { months: monthList, labourers, grand });
  } catch (e) { fail(res, e); }
});

// ============================================================ PRICES
app.get('/api/prices', (req, res) => {
  try {
    const { q } = req.query;
    const { sql, params } = likeWhere(['description', 'supplier', 'purchase_type'], q);
    ok(res, db.prepare('SELECT * FROM prices' + sql + ' ORDER BY description LIMIT 2000').all(...params));
  } catch (e) { fail(res, e); }
});

app.post('/api/prices', (req, res) => {
  try {
    const b = req.body;
    const info = db.prepare(`INSERT INTO prices (mrn, description, purchase_type, vehicle, qty, current_price, grn_no, invoice_no, supplier, date)
      VALUES (@mrn,@description,@purchase_type,@vehicle,@qty,@current_price,@grn_no,@invoice_no,@supplier,@date)`)
      .run({ mrn: b.mrn || null, description: b.description || null, purchase_type: b.purchase_type || null, vehicle: b.vehicle || null,
        qty: b.qty ?? null, current_price: b.current_price ?? null, grn_no: b.grn_no || null, invoice_no: b.invoice_no || null,
        supplier: b.supplier || null, date: b.date || null });
    ok(res, db.prepare('SELECT * FROM prices WHERE id = ?').get(info.lastInsertRowid));
  } catch (e) { fail(res, e); }
});

app.put('/api/prices/:id', (req, res) => {
  try {
    const b = req.body;
    db.prepare(`UPDATE prices SET mrn=@mrn, description=@description, purchase_type=@purchase_type, vehicle=@vehicle,
      qty=@qty, current_price=@current_price, grn_no=@grn_no, invoice_no=@invoice_no, supplier=@supplier, date=@date WHERE id=@id`)
      .run({ id: req.params.id, mrn: b.mrn ?? null, description: b.description ?? null, purchase_type: b.purchase_type ?? null,
        vehicle: b.vehicle ?? null, qty: b.qty ?? null, current_price: b.current_price ?? null, grn_no: b.grn_no ?? null,
        invoice_no: b.invoice_no ?? null, supplier: b.supplier ?? null, date: b.date ?? null });
    ok(res, db.prepare('SELECT * FROM prices WHERE id = ?').get(req.params.id));
  } catch (e) { fail(res, e); }
});

app.delete('/api/prices/:id', (req, res) => {
  try { db.prepare('DELETE FROM prices WHERE id = ?').run(req.params.id); ok(res, { ok: true }); }
  catch (e) { fail(res, e); }
});

// ============================================================ JOB COST REPORT
// Matches a job's materials & labour by vehicle within the job date window,
// prices materials from the Price list where a description match exists.
app.get('/api/report/job/:jobNo', (req, res) => {
  try {
    const job = db.prepare('SELECT * FROM jobs WHERE job_no = ?').get(req.params.jobNo);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    const start = job.start_date;
    const end = job.end_date || new Date().toISOString().slice(0, 10);

    const materials = db.prepare(`SELECT * FROM material_issues
      WHERE vehicle = ? AND date IS NOT NULL AND date != '' AND date >= ? AND date <= ? ORDER BY date`).all(job.vehicle, start, end);

    // price lookup by exact-ish description
    const priceFor = db.prepare('SELECT current_price FROM prices WHERE description = ? ORDER BY id DESC LIMIT 1');
    let materialCost = 0;
    const pricedMaterials = materials.map((m) => {
      const p = priceFor.get(m.description);
      const unit = p ? p.current_price : null;
      const line = unit != null && m.qty != null ? unit * m.qty : null;
      if (line) materialCost += line;
      return { ...m, unit_price: unit, line_total: line };
    });

    const work = db.prepare(`SELECT * FROM daily_work
      WHERE vehicle = ? AND date IS NOT NULL AND date != '' AND date >= ? AND date <= ? ORDER BY date`).all(job.vehicle, start, end);
    const labourHours = work.reduce((s, w) => s + (w.man_hours || 0), 0);

    // labour cost via fuzzy rate matching
    const labour = computeLabour(work, loadAliases());

    ok(res, { job, materials: pricedMaterials, work,
      labour: labour.perMechanic,
      summary: {
        materialCost, labourHours,
        labourCost: labour.cost,
        labourUnmatchedHours: labour.unmatchedHours,
        totalCost: materialCost + labour.cost,
        lines: pricedMaterials.length, start, end,
      } });
  } catch (e) { fail(res, e); }
});

// ============================================================ REPORTS: misc
app.get('/api/report/labour-monthly', (req, res) => {
  try {
    ok(res, db.prepare(`SELECT substr(date,1,7) month, mechanic, SUM(man_hours) hours
      FROM daily_work WHERE date IS NOT NULL AND mechanic IS NOT NULL
      GROUP BY month, mechanic ORDER BY month DESC, hours DESC LIMIT 500`).all());
  } catch (e) { fail(res, e); }
});

app.get('/api/report/pending-mrn', (req, res) => {
  try {
    // MRN requests that have no matching received item (by mr_no)
    ok(res, db.prepare(`SELECT mi.* FROM material_issues mi
      WHERE mi.category IN ('MRN','Tyre')
        AND mi.mr_no IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM received_items ri WHERE ri.mr_no = mi.mr_no)
      ORDER BY mi.date DESC LIMIT 1000`).all());
  } catch (e) { fail(res, e); }
});

// ---------------------------------------------------------------- static
app.use(express.static(join(__dirname, '..', 'client')));
app.use((req, res) => res.sendFile(join(__dirname, '..', 'client', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Job Costing webapp running → http://localhost:${PORT}`));
