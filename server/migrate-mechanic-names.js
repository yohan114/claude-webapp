// Migration: fix mechanic name spelling in daily_work to match official labour list.
// Safe to run multiple times (idempotent).
import { db, initSchema } from './db.js';

initSchema();

const fixes = {
  // Anura
  'Anara':'Anura','anura':'Anura',
  // Buddhika
  'Budbika':'Buddhika','Buddika':'Buddhika','Buddilca':'Buddhika','Buddka':'Buddhika',
  // Chaminda
  'Chamika':'Chaminda','chaminda':'Chaminda',
  // Govinda
  'Givinda':'Govinda','Govind:':'Govinda','Govindan':'Govinda','Govindu':'Govinda','Gravinda':'Govinda','Grovinda':'Govinda',
  // Jayaweera
  'Jayavakeera':'Jayaweera','Jayaveera':'Jayaweera',
  // Krishna
  'Kosshna':'Krishna','Kristina':'Krishna','Krushna':'Krishna','krishna':'Krishna',
  // Nawathilaka
  'Navathilaka':'Nawathilaka','Nawathilake':'Nawathilaka',
  // Nimal
  'nimal':'Nimal',
  // Nimesh
  'nimesh':'Nimesh',
  // Ruwan
  'Rawan':'Ruwan','ruwan':'Ruwan','Nuwan':'Ruwan',
  // Saman (Samanpriya = full name of Saman)
  'saman':'Saman','Samanpriya':'Saman',
  // Seethananda/seetha
  'Seetha':'Seethananda/seetha','Seethananda':'Seethananda/seetha','Seethe':'Seethananda/seetha',
  // Theshan
  '(Theshan)':'Theshan','Thashan':'Theshan','Theminda':'Theshan','theminda':'Theshan','theshan':'Theshan','Heshan':'Theshan','Reshan':'Theshan',
  // Viboda
  'vibod':'Viboda','viboda':'Viboda','Vihanga':'Viboda','Vihaga':'Viboda',
  // Vinod
  'Vinoth':'Vinod','Vined (E)':'Vinod','Vinod (CE)':'Vinod','Vinod (E)':'Vinod','vinod':'Vinod','vinoth':'Vinod','Kinoth':'Vinod',
  // Vinod M
  'Vinod (M)':'Vinod M','Vinod e':'Vinod M',
  // Two-person compound cells (dot-separated → comma-separated)
  // handled by replacing dots with commas below
};

const rows = db.prepare('SELECT id, mechanic FROM daily_work WHERE mechanic IS NOT NULL').all();
const update = db.prepare('UPDATE daily_work SET mechanic=? WHERE id=?');
let changed = 0;

db.transaction(() => {
  for (const row of rows) {
    let val = row.mechanic;

    // 1. Replace dots with commas (Buddhika.Viboda → Buddhika, Viboda)
    val = val.replace(/\./g, ', ');

    // 2. Fix Seethananda chain duplicates first
    val = val.replace(/Seethananda(?:\/(?:Seethananda|seetha))+/g, 'Seethananda/seetha');

    // 3. Fix Seethananda/seetha standalone variants
    val = val.replace(/\bSeethananda\b/g, 'Seethananda/seetha')
             .replace(/\bseetha\b/gi, 'Seethananda/seetha');

    // 4. Fix remaining tokens (split on comma, fix each, rejoin)
    const parts = val.split(/([,]+)/);
    const fixed = parts.map(p => {
      const t = p.trim();
      return fixes[t] ? p.replace(t, fixes[t]) : p;
    });
    val = fixed.join('');

    if (val !== row.mechanic) { update.run(val, row.id); changed++; }
  }
})();

console.log(`Mechanic names fixed: ${changed} rows`);

// Report final state
const all = db.prepare('SELECT DISTINCT mechanic FROM daily_work WHERE mechanic IS NOT NULL').all();
const tokens = new Set();
for (const r of all) String(r.mechanic).split(/[,]+/).forEach(t => { const s = t.trim(); if (s) tokens.add(s); });
const canonical = new Set(['Anura','Vinod','Chaminda','Viboda','Dinesh','Krishna','Govinda','Buddhika','Theshan',
  'Jayaweera','Seethananda/seetha','Nimal','Nawathilaka','Saman','Ruwan','Vinod M','Nimesh']);
const unmatched = [...tokens].filter(t => !canonical.has(t)).sort();
if (unmatched.length) console.log('Still unmatched (no rate):', unmatched);
else console.log('All mechanics matched to official list.');
