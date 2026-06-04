// One-time seed: read the original Job Costing Excel workbook into SQLite.
// Usage: node server/import-excel.js <path-to-xlsx>
import xlsx from 'xlsx';
import { db, initSchema } from './db.js';

const file = process.argv[2];
if (!file) {
  console.error('Usage: node server/import-excel.js <path-to-xlsx>');
  process.exit(1);
}

initSchema();
const wb = xlsx.readFile(file, { cellDates: true });

// helpers -----------------------------------------------------------------
// raw:true keeps date cells as JS Date objects (cellDates:true above), so iso() parses
// them correctly. raw:false reformats them into locale strings that misparse (year 2001 bug).
const sheet = (name) => (wb.Sheets[name] ? xlsx.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: null }) : []);
const iso = (v) => {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d) ? String(v) : d.toISOString().slice(0, 10);
};
const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? null : n;
};
const str = (v) => (v === null || v === undefined ? null : String(v).trim() || null);

// wipe so re-imports are idempotent
for (const t of ['fleet', 'jobs', 'material_issues', 'daily_work', 'prices', 'received_items', 'labour_rates']) {
  db.exec(`DELETE FROM ${t}`);
}

// Labour hour price -------------------------------------------------------
(() => {
  const rows = sheet('Labour hour price');
  const stmt = db.prepare('INSERT OR IGNORE INTO labour_rates (name, hour_price) VALUES (?,?)');
  let n = 0;
  for (const r of rows) {
    // sheet has a leading empty column; name/price live in cols B/C (idx 1/2)
    const cells = r.filter((c) => c !== null);
    if (cells.length < 2) continue;
    const name = str(cells[0]); const price = num(cells[1]);
    if (!name || /labour name/i.test(name) || price == null) continue;
    stmt.run(name, price); n++;
  }
  console.log(`Labour rates: ${n}`);
})();

// Fleet -------------------------------------------------------------------
(() => {
  const rows = sheet('Fleet');
  const headerIdx = rows.findIndex((r) => String(r[0]).trim() === 'NO');
  if (headerIdx < 0) return;
  const stmt = db.prepare(`INSERT INTO fleet
    (no, description, ec_number, brand, type, model, reg_no, capacity, year, chassis_no, engine_no, gps, site)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  let last = {};
  let n = 0;
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.every((c) => c === null)) continue;
    // forward-fill description (it spans merged blocks in the sheet)
    const desc = str(r[1]) || last.description;
    if (str(r[1])) last.description = str(r[1]);
    if (!str(r[2]) && !str(r[6])) continue; // need at least E&C or reg no
    stmt.run(num(r[0]), desc, str(r[2]), str(r[3]), str(r[4]), str(r[5]), str(r[6]), str(r[7]), str(r[8]), str(r[10]), str(r[11]), str(r[12]), str(r[13]));
    n++;
  }
  console.log(`Fleet: ${n}`);
})();

// Jobs --------------------------------------------------------------------
(() => {
  const rows = sheet('Job record');
  const stmt = db.prepare(`INSERT OR IGNORE INTO jobs
    (job_no, ref, vehicle, description, start_date, end_date, site, remarks)
    VALUES (?,?,?,?,?,?,?,?)`);
  let n = 0;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!str(r[0])) continue;
    const end = str(r[5]) && str(r[5]) !== '-' ? iso(r[5]) : null;
    stmt.run(str(r[0]), str(r[1]), str(r[2]), str(r[3]), iso(r[4]), end, str(r[8]), str(r[9]));
    n++;
  }
  console.log(`Jobs: ${n}`);
})();

// Material issues (5 categories + MRN) ------------------------------------
const insMI = db.prepare(`INSERT INTO material_issues
  (category, mr_no, date, description, unit, type, qty, vehicle, site, remarks)
  VALUES (?,?,?,?,?,?,?,?,?,?)`);

// Map columns by HEADER NAME (robust to leading-empty-column drift between sheets).
// `spec` maps a db field → list of accepted header-name regexes.
function importMI(sheetName, category, spec) {
  const rows = sheet(sheetName);
  // header row = the one matching the most of our header patterns
  const allPats = Object.values(spec).flat();
  let hIdx = -1, best = 0;
  rows.forEach((r, i) => {
    if (!r) return;
    const score = allPats.filter((p) => r.some((c) => c != null && p.test(String(c).trim()))).length;
    if (score > best) { best = score; hIdx = i; }
  });
  if (hIdx < 0) return 0;
  const header = rows[hIdx].map((c) => (c == null ? '' : String(c).trim()));
  // resolve each field to a column index
  const colOf = {};
  for (const [field, pats] of Object.entries(spec)) {
    colOf[field] = header.findIndex((h) => pats.some((p) => p.test(h)));
  }
  const isDate = new Set(['date']);
  const isNum = new Set(['qty']);
  let n = 0;
  for (let i = hIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.every((c) => c === null)) continue;
    const rec = {};
    for (const field of Object.keys(spec)) {
      const idx = colOf[field];
      const v = idx >= 0 ? r[idx] : null;
      rec[field] = isDate.has(field) ? iso(v) : isNum.has(field) ? num(v) : str(v);
    }
    if (!rec.description && !rec.vehicle) continue;
    insMI.run(category, rec.mr_no || null, rec.date || null, rec.description || null,
      rec.unit || null, rec.type || null, rec.qty ?? null, rec.vehicle || null, rec.site || null, rec.remarks || null);
    n++;
  }
  return n;
}

console.log('Battery:', importMI('Battery RQ,IS', 'Battery', {
  mr_no: [/^MR No/i], date: [/^Date/i], description: [/^Desc/i], unit: [/^Unit/i], qty: [/^Qty/i], vehicle: [/Vehicle|Equipment/i], site: [/^Remark/i],
}));
console.log('Filter:', importMI('Filter IS', 'Filter', {
  date: [/^Date/i], vehicle: [/Vehical|Vehicle/i], description: [/^Desc/i], qty: [/^Qty/i],
}));
console.log('Lubricant:', importMI('Lubricant IS', 'Lubricant', {
  date: [/^Date/i], vehicle: [/Vehicle/i], description: [/^Desc/i], type: [/^Type/i], qty: [/^Qty/i],
}));
console.log('General:', importMI('General Items IS', 'General', {
  date: [/^Date/i], description: [/^Desc/i], qty: [/^Qty/i], vehicle: [/Vehicle/i],
}));
console.log('Tyre:', importMI('Tyre Mrn RQ IS', 'Tyre', {
  mr_no: [/^MRN/i], date: [/^Date/i], description: [/^Desc/i], qty: [/^Qty/i], vehicle: [/Vehicle/i],
}));
console.log('MRN:', importMI('MRN Items RQ IS', 'MRN', {
  mr_no: [/^MRN/i], date: [/^Date/i], description: [/^Desc/i], qty: [/^Qty/i], vehicle: [/Vehicle/i],
}));

// Daily Work done ---------------------------------------------------------
(() => {
  const rows = sheet('Daily Work done');
  const stmt = db.prepare(`INSERT INTO daily_work (date, vehicle, description, mechanic, hours, man_hours, remarks) VALUES (?,?,?,?,?,?,?)`);
  let n = 0;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!str(r[1]) && !str(r[2])) continue;
    stmt.run(iso(r[0]), str(r[1]), str(r[2]), str(r[3]), num(r[4]), num(r[8]), str(r[5]));
    n++;
  }
  console.log(`Daily work: ${n}`);
})();

// Prices ------------------------------------------------------------------
(() => {
  const rows = sheet('Price');
  const stmt = db.prepare(`INSERT INTO prices (mrn, description, purchase_type, vehicle, qty, current_price, grn_no, invoice_no, supplier, date) VALUES (?,?,?,?,?,?,?,?,?,?)`);
  let n = 0;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!str(r[1])) continue;
    stmt.run(str(r[0]), str(r[1]), str(r[2]), str(r[3]), num(r[4]), num(r[5]), str(r[6]), str(r[7]), str(r[8]), iso(r[9]));
    n++;
  }
  console.log(`Prices: ${n}`);
})();

// Received items ----------------------------------------------------------
(() => {
  const rows = sheet('Received Items RS');
  const stmt = db.prepare(`INSERT INTO received_items (date, description, purchase_type, qty, vehicle, mr_no) VALUES (?,?,?,?,?,?)`);
  let n = 0;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!str(r[1])) continue;
    const ptype = str(r[2]) ? 'Local' : str(r[3]) ? 'Head Office' : null;
    stmt.run(iso(r[0]), str(r[1]), ptype, num(r[4]), str(r[5]), str(r[6]));
    n++;
  }
  console.log(`Received items: ${n}`);
})();

console.log('\nImport complete.');
