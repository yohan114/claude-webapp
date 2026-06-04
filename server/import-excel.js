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
const sheet = (name) => (wb.Sheets[name] ? xlsx.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: false, defval: null }) : []);
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
for (const t of ['fleet', 'jobs', 'material_issues', 'daily_work', 'prices', 'received_items']) {
  db.exec(`DELETE FROM ${t}`);
}

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

function importMI(sheetName, category, map, headerMatch) {
  const rows = sheet(sheetName);
  const hIdx = rows.findIndex((r) => r && r.some((c) => headerMatch.test(String(c))));
  if (hIdx < 0) return 0;
  let n = 0;
  for (let i = hIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.every((c) => c === null)) continue;
    const rec = map(r);
    if (!rec.description && !rec.vehicle) continue;
    insMI.run(category, rec.mr_no || null, rec.date || null, rec.description || null,
      rec.unit || null, rec.type || null, rec.qty ?? null, rec.vehicle || null, rec.site || null, rec.remarks || null);
    n++;
  }
  return n;
}

// Battery RQ,IS: HEAD, MR No., Date, Description, Unit, Qty, Vehicle, Remark
console.log('Battery:', importMI('Battery RQ,IS', 'Battery', (r) => ({
  mr_no: str(r[1]), date: iso(r[2]), description: str(r[3]), unit: str(r[4]), qty: num(r[5]), vehicle: str(r[6]), site: str(r[7]),
}), /MR No/i));

// Filter IS: HEAD, Date, Vehical Number, Description, Qty
console.log('Filter:', importMI('Filter IS', 'Filter', (r) => ({
  date: iso(r[1]), vehicle: str(r[2]), description: str(r[3]), qty: num(r[4]),
}), /Vehical|Vehicle/i));

// Lubricant IS: HEAD, Date, Vehicle No, Description, Type, Qty
console.log('Lubricant:', importMI('Lubricant IS', 'Lubricant', (r) => ({
  date: iso(r[1]), vehicle: str(r[2]), description: str(r[3]), type: str(r[4]), qty: num(r[5]),
}), /Vehicle No/i));

// General Items IS: a, Date, Description, Qty, Vehicle No
console.log('General:', importMI('General Items IS', 'General', (r) => ({
  date: iso(r[1]), description: str(r[2]), qty: num(r[3]), vehicle: str(r[4]),
}), /Description/i));

// Tyre Mrn RQ IS: _, MRN No, Date, Description, Qty, Vehicle
console.log('Tyre:', importMI('Tyre Mrn RQ IS', 'Tyre', (r) => ({
  mr_no: str(r[1]), date: iso(r[2]), description: str(r[3]), qty: num(r[4]), vehicle: str(r[5]),
}), /MRN No/i));

// MRN Items RQ IS: _, MRN, Date, Description, Qty, Vehicle No
console.log('MRN:', importMI('MRN Items RQ IS', 'MRN', (r) => ({
  mr_no: str(r[1]), date: iso(r[2]), description: str(r[3]), qty: num(r[4]), vehicle: str(r[5]),
}), /MRN/i));

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
