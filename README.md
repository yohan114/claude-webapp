# Fleet Job Costing Web App

A fast, single-page web application that replaces the multi-sheet **Job Costing**
Excel workbook used for fleet/equipment maintenance at multiple sites. Built for
quick daily data entry and instant job-cost reporting.

## Features

| Module | What it does |
|--------|--------------|
| **Dashboard** | Live stats (open jobs, fleet size, labour hours), material-by-category and jobs-by-site charts, recent jobs |
| **Jobs** | Create/edit/close repair jobs with **auto-generated job numbers** (`YYYY/M/R/NNN`), filter Open/Closed, click a job → full cost report |
| **Fleet** | Searchable registry of all vehicles/equipment; click any vehicle for its 360° history |
| **Materials** | Issue & track Battery / Filter / Lubricant / General / Tyre / MRN items per vehicle |
| **Work Log** | Daily mechanic work entry with automatic man-hour calculation (hours × number of mechanics) |
| **Prices** | Item price list with supplier & purchase type |
| **Reports** | Job Cost Summary (auto-prices materials + sums labour within the job window), Monthly Labour Hours, Pending MRN/Tyre requests |

### Fast-use touches
- Global search (`/` to focus) filters the current view live
- `N` opens the "new record" form on any module
- Vehicle/site **type-ahead** datalists on every form
- Click-through links: Job → cost report, Vehicle → full history
- Sortable columns everywhere

## Tech stack
- **Backend:** Node.js + Express 5 + better-sqlite3 (file-based, zero-config, offline-capable)
- **Frontend:** Vanilla JS SPA + CSS — no build step, instant load
- **Import:** SheetJS (`xlsx`) seeds the database from the original workbook

## Getting started

```bash
npm install

# One-time: import the existing Excel workbook into SQLite
node server/import-excel.js /path/to/Job_Costing_Updated.xlsx

# Start the app
npm start          # → http://localhost:3000
```

The database lives at `server/data/jobcosting.db` (git-ignored). Re-running the
import is idempotent — it wipes and reloads the imported tables.

## API overview

```
GET    /api/dashboard
GET    /api/jobs?status=&q=          POST/PUT/DELETE /api/jobs[/:id]
GET    /api/jobs/next-no
GET    /api/fleet?q=&site=           GET /api/fleet/sites
GET    /api/vehicle/:reg             (jobs + materials + work for one vehicle)
GET    /api/materials?category=&q=   POST/PUT/DELETE /api/materials[/:id]
GET    /api/worklog?q=&from=&to=     POST/PUT/DELETE /api/worklog[/:id]
GET    /api/prices?q=                POST/PUT/DELETE /api/prices[/:id]
GET    /api/report/job/:jobNo        GET /api/report/labour-monthly
GET    /api/report/pending-mrn
```
