// Migration: fix mechanic name spelling in daily_work to match official labour list.
// Safe to run multiple times (idempotent).
import { db, initSchema } from './db.js';

initSchema();

// Official canonical names (18 labourers)
const CANONICAL = new Set([
  'Anura','Vinod','Vinoth','Chaminda','Viboda','Dinesh','Krishna','Govinda',
  'Buddhika','Theshan','Jayaweera','Seethananda/seetha','Nimal','Nawathilaka',
  'Saman','Ruwan','Vinod M','Nimesh',
]);

// Token-level fixes: variant → canonical
const TOKEN_FIX = {
  // Anura
  'Anara':'Anura','anura':'Anura',
  // Buddhika
  'Budbika':'Buddhika','Buddika':'Buddhika','Buddilca':'Buddhika','Buddka':'Buddhika',
  // Chaminda
  'Chamika':'Chaminda','chaminda':'Chaminda',
  // Govinda
  'Givinda':'Govinda','Govind:':'Govinda','Govindan':'Govinda','Govindu':'Govinda',
  'Gravinda':'Govinda','Grovinda':'Govinda',
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
  // Ruwan (Nuwan = Ruwan)
  'Rawan':'Ruwan','ruwan':'Ruwan','Nuwan':'Ruwan',
  // Saman (Samanpriya = full name of Saman)
  'saman':'Saman','Samanpriya':'Saman',
  // Theshan
  '(Theshan)':'Theshan','Thashan':'Theshan','Theminda':'Theshan',
  'theminda':'Theshan','theshan':'Theshan','Heshan':'Theshan','Reshan':'Theshan',
  // Viboda (Vihanga/Vihaga = Viboda)
  'vibod':'Viboda','viboda':'Viboda','Vihanga':'Viboda','Vihaga':'Viboda',
  // Vinod (electrical, Rs 375)
  'Vined (E)':'Vinod','Vinod (CE)':'Vinod','Vinod (E)':'Vinod','Vinod E':'Vinod',
  'vinod':'Vinod','Kinoth':'Vinod',
  // Vinoth (electrical, Rs 250) — separate person, do NOT map to Vinod
  'vinoth':'Vinoth',
  // Vinod M
  'Vinod (M)':'Vinod M','Vinod e':'Vinod M',
  // Seethananda/seetha — chain handled below; add extra variants here
  'Seethe':'Seethananda/seetha',
};

// Space-separated compound tokens that mean two people → split with comma
const SPLIT_COMPOUNDS = {
  'Buddika Viboda':'Buddhika, Viboda',
  'Nimesh Govinda':'Nimesh, Govinda',
  'Nuwan Nimesh':'Ruwan, Nimesh',
  'Ruwan Nimesh':'Ruwan, Nimesh',
  'Vinod(M) Nimesh':'Vinod M, Nimesh',
};

const rows = db.prepare('SELECT id, mechanic FROM daily_work WHERE mechanic IS NOT NULL').all();
const update = db.prepare('UPDATE daily_work SET mechanic=? WHERE id=?');
let changed = 0;

db.transaction(() => {
  for (const row of rows) {
    let val = row.mechanic;

    // 1. Replace dots with commas (Buddhika.Viboda → Buddhika, Viboda)
    val = val.replace(/\./g, ', ');

    // 2. Collapse any Seethananda chain to canonical
    val = val.replace(/Seethananda(?:\/(?:Seethananda|seetha))*/gi, 'Seethananda/seetha');
    // Fix standalone 'seetha' only when NOT already part of 'Seethananda/seetha'
    val = val.replace(/(?<!Seethananda\/)\bseetha\b/gi, 'Seethananda/seetha');

    // 3. Split known two-person space-separated tokens (whole-cell match)
    if (SPLIT_COMPOUNDS[val.trim()]) {
      val = SPLIT_COMPOUNDS[val.trim()];
    } else {
      // 4. Fix each comma-separated token individually
      const parts = val.split(/([,]+)/);
      val = parts.map(p => {
        const t = p.trim();
        // Try full compound split first
        if (SPLIT_COMPOUNDS[t]) return p.replace(t, SPLIT_COMPOUNDS[t]);
        // Then token fix
        return TOKEN_FIX[t] ? p.replace(t, TOKEN_FIX[t]) : p;
      }).join('');
    }

    if (val !== row.mechanic) { update.run(val, row.id); changed++; }
  }
})();

console.log(`Mechanic names fixed: ${changed} rows`);

// Report final state
const all = db.prepare('SELECT DISTINCT mechanic FROM daily_work WHERE mechanic IS NOT NULL').all();
const tokens = new Set();
for (const r of all) String(r.mechanic).split(/[,]+/).forEach(t => { const s = t.trim(); if (s) tokens.add(s); });
const unmatched = [...tokens].filter(t => !CANONICAL.has(t)).sort();
if (unmatched.length) console.log('Still unmatched (no rate):', unmatched);
else console.log('All mechanics matched to official list.');
