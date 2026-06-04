import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdirSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, 'data');
mkdirSync(dataDir, { recursive: true });

export const db = new Database(join(dataDir, 'jobcosting.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

export function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS fleet (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      no          INTEGER,
      description TEXT,
      ec_number   TEXT,
      brand       TEXT,
      type        TEXT,
      model       TEXT,
      reg_no      TEXT,
      capacity    TEXT,
      year        TEXT,
      chassis_no  TEXT,
      engine_no   TEXT,
      gps         TEXT,
      site        TEXT
    );

    CREATE TABLE IF NOT EXISTS jobs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      job_no      TEXT UNIQUE,
      ref         TEXT,
      vehicle     TEXT,
      description TEXT,
      start_date  TEXT,
      end_date    TEXT,
      site        TEXT,
      cost        REAL,
      remarks     TEXT,
      created_at  TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS material_issues (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      category    TEXT NOT NULL,           -- Battery | Filter | Lubricant | General | Tyre | MRN
      mr_no       TEXT,
      date        TEXT,
      description TEXT,
      unit        TEXT,
      type        TEXT,
      qty         REAL,
      vehicle     TEXT,
      site        TEXT,
      remarks     TEXT,
      created_at  TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS daily_work (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      date        TEXT,
      vehicle     TEXT,
      description TEXT,
      mechanic    TEXT,
      hours       REAL,
      man_hours   REAL,
      remarks     TEXT,
      created_at  TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS prices (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      mrn           TEXT,
      description   TEXT,
      purchase_type TEXT,
      vehicle       TEXT,
      qty           REAL,
      current_price REAL,
      grn_no        TEXT,
      invoice_no    TEXT,
      supplier      TEXT,
      date          TEXT
    );

    CREATE TABLE IF NOT EXISTS received_items (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      date          TEXT,
      description   TEXT,
      purchase_type TEXT,
      qty           REAL,
      vehicle       TEXT,
      mr_no         TEXT
    );

    CREATE TABLE IF NOT EXISTS labour_rates (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT UNIQUE,
      hour_price  REAL
    );

    CREATE INDEX IF NOT EXISTS idx_jobs_vehicle ON jobs(vehicle);
    CREATE INDEX IF NOT EXISTS idx_mi_vehicle  ON material_issues(vehicle);
    CREATE INDEX IF NOT EXISTS idx_mi_category ON material_issues(category);
    CREATE INDEX IF NOT EXISTS idx_dw_vehicle  ON daily_work(vehicle);
    CREATE INDEX IF NOT EXISTS idx_prices_desc ON prices(description);
  `);
}
