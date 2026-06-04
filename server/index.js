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
    const { q, category } = req.query;
    let sql = 'SELECT * FROM material_issues';
    const params = [];
    const clauses = [];
    if (category) { clauses.push('category = ?'); params.push(category); }
    if (q) { clauses.push('(description LIKE ? OR vehicle LIKE ? OR mr_no LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
    if (clauses.length) sql += ' WHERE ' + clauses.join(' AND ');
    sql += ' ORDER BY id DESC LIMIT 3000';
    ok(res, db.prepare(sql).all(...params));
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
    let sql = 'SELECT * FROM daily_work';
    const params = [];
    const clauses = [];
    if (q) { clauses.push('(vehicle LIKE ? OR description LIKE ? OR mechanic LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
    if (from) { clauses.push('date >= ?'); params.push(from); }
    if (to) { clauses.push('date <= ?'); params.push(to); }
    if (clauses.length) sql += ' WHERE ' + clauses.join(' AND ');
    sql += ' ORDER BY date DESC, id DESC LIMIT 3000';
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
      WHERE vehicle = ? AND (date IS NULL OR (date >= ? AND date <= ?)) ORDER BY date`).all(job.vehicle, start, end);

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
      WHERE vehicle = ? AND (date IS NULL OR (date >= ? AND date <= ?)) ORDER BY date`).all(job.vehicle, start, end);
    const labourHours = work.reduce((s, w) => s + (w.man_hours || 0), 0);

    ok(res, { job, materials: pricedMaterials, work, summary: { materialCost, labourHours, lines: pricedMaterials.length } });
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
