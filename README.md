# LeoMox IT Solutions — Website + HRMS

Node/Express + Neon Postgres backend serving a single static frontend
(`public/index.html`, untouched) and a JSON API under `/api/*`.

## What was fixed originally

Your uploaded `routes/` folder came through as an empty 0‑byte file, so none
of the route handlers existed — `server.js` would have crashed immediately
on `require('./routes/auth.routes')` etc. `server.js` also pointed its
static file serving one directory *above* the project. Both are fixed:
every route file exists, and `server.js` serves `./public` correctly.

## What was added in this pass (verify + enhance)

`migrate.sql` already defined ~25 extra employee columns and whole tables
(bank details, statutory/PF/ESI/PAN, salary structures, leave balances,
leave requests, payroll) that the first backend pass never actually used —
routes only round-tripped the 8 basic fields the current employee form
sends. This pass wires up everything the schema supports:

- **`routes/employees.routes.js`** — full 30+ field profile (personal,
  address, emergency contact, employment dates, reporting manager, login
  link), plus `PUT /:id/bank` and `PUT /:id/statutory` sub-resources, plus
  `GET /me` for self-service. Every field is validated (PAN/IFSC/UAN/pincode
  formats, cross-field date checks, enum whitelists) — see `utils/employee.js`.
- **`routes/attendance.routes.js`** — bulk marking, self-service check-in/
  check-out with real clock times, a monthly summary endpoint, and a check
  that a *locked* payroll month can no longer have its attendance edited.
- **`routes/leave.routes.js`** — balances per leave type/year, applying for
  leave (with overlap detection, weekly-off-aware day counting, and a
  balance check for paid leave types), and a two-step Manager→HR approval
  workflow that writes approved leave into `attendance` so payroll sees it
  automatically as paid leave or unpaid LOP.
- **`routes/payroll.routes.js`** — `preview`/`generate` build actual payroll
  from each employee's attendance (LOP), salary structure or statutory
  record, and joining/leaving dates; `approve-all`/`lock` publish payslips;
  `GET /payslip` lets an employee see (only) their own *published* payslip.
- **`routes/dashboard.routes.js`** (new) — role-aware summary: birthdays/
  anniversaries and new joiners for everyone; department headcount, today's
  attendance breakdown, and pending-leave counts for staff roles only.
- **`utils/hr.js`** — pure, unit-tested date/leave/payroll math (see
  `tests/hr.test.js`, 17 cases covering timezone edge cases, leap years,
  LOP proration, and the exact numbers the original hardcoded payslip used).
- **`migrate_v2.sql`** — a few schema corrections the enhancements needed:
  unique constraints so an employee has at most one bank/statutory record,
  `payroll.paid_days`/`lop_days` widened to allow half-days, and several
  foreign keys changed to `ON DELETE SET NULL` so deleting a user doesn't
  get blocked by their own audit-log history.
- **`scripts/migrate.js`** (`npm run db:migrate`) — applies `schema.sql`,
  `migrate.sql`, and `migrate_v2.sql` in order in one command instead of
  pasting three files into the SQL editor by hand.

**Important — what did *not* change:** `public/index.html` is byte-for-byte
your original file. Its Dashboard tab (shown to every role, including plain
`employee`) reads `HRMS.employees`/`HRMS.invoices` directly from
`/api/bootstrap`'s response with no per-role filtering — so `/api/bootstrap`
still returns the full company-wide employees/users/invoices lists to any
authenticated role, exactly as the original app relied on. All the new
role-based restrictions above apply to the *dedicated* REST endpoints
(`GET /api/employees`, `/api/payroll/*`, etc.), which the current UI doesn't
call yet — they're ready for whenever you build screens for them, without
touching what already works today.

## Project layout

```
server.js               Express app entrypoint
db.js                   Neon serverless Postgres client
schema.sql               Base schema
migrate.sql               Phase 1–8 additions (bank, statutory, salary, leave, payroll, audit…)
migrate_v2.sql            This pass's schema corrections
scripts/migrate.js        Runs all three SQL files in order — npm run db:migrate
seed.js                    Creates the 4 default accounts
middleware/
  auth.js                  JWT auth + role guards (requireAdmin/Manager/HR/AdminHR/Auth)
  permissions.js            Per-user permission override resolver
utils/
  audit.js                 Writes to audit_logs on every mutating action
  hr.js                     Pure date/leave/payroll math — unit tested
  employee.js               Shared employee lookup/scoping/validation helpers
  sqlsplit.js               Splits a .sql file into statements for the migration runner
routes/
  auth.routes.js            login / logout / me / change-password
  users.routes.js            user management (admin only) + /options (admin+HR)
  employees.routes.js        full profile CRUD + /me, /:id/bank, /:id/statutory
  attendance.routes.js       marking, bulk marking, check-in/out, summary
  leave.routes.js            types, balances, apply, manager/HR approval, cancel
  payroll.routes.js          preview, generate, approve-all, lock, payslip, my payslips
  invoices.routes.js         tax invoices (admin + manager)
  contact.routes.js          public contact form + admin/manager inbox
  siteContent.routes.js      public site copy (view: public, edit: admin)
  dashboard.routes.js        role-aware summary widgets
  permissions.routes.js      per-user permission overrides (admin)
  audit.routes.js            audit log viewer (admin only)
  notifications.routes.js    per-user notifications
public/
  index.html                 your frontend, unmodified
tests/
  hr.test.js                 17 unit tests for utils/hr.js
  routes.test.js              30 integration tests against the real route files (fake DB)
  harness.js                  the fake express/sql test harness
```

## API surface actually used by `index.html` today

| Method | Path | Who |
|---|---|---|
| POST | `/api/auth/login` | public |
| POST | `/api/auth/logout` | logged in |
| GET | `/api/auth/me` | logged in |
| POST | `/api/auth/change-password` | logged in |
| GET | `/api/bootstrap` | logged in — returns full company data (see note above) |
| GET/POST/PUT/DELETE | `/api/employees[/:id]` | write: admin (matches `can('users')` in the UI) |
| GET/POST/PUT/DELETE/`toggle-active` | `/api/users[/:id]` | admin |
| POST | `/api/attendance/mark` | logged in |
| POST/PUT | `/api/invoices[/:id]` | admin, manager |
| POST | `/api/contact` | public |
| GET/PUT | `/api/contact[/:id/status]` | admin, manager |
| GET | `/api/site-content` | public |
| PUT | `/api/site-content` | admin |

Everything else in the table under "Project layout" is a working, tested
API that the current screens don't call yet.

## 1. Set up Neon Postgres

1. Create a project at [neon.tech](https://neon.tech) and copy the pooled
   connection string.
2. Run the migration:
   ```bash
   npm install
   cp .env.example .env   # fill in DATABASE_URL (see step 2 below)
   npm run db:migrate
   ```
   This applies `schema.sql` → `migrate.sql` → `migrate_v2.sql`, in order.
   Every statement is idempotent (`IF NOT EXISTS` / `ON CONFLICT` /
   `DROP ... IF EXISTS` before re-adding), so it's safe to run again later
   (e.g. after pulling updates) without duplicating anything.

   Alternatively, paste the three files into the Neon SQL Editor by hand in
   that same order.

## 2. Configure environment variables

Fill in `.env` (copied from `.env.example`):
- `DATABASE_URL` — from Neon.
- `JWT_SECRET` — generate with:
  ```bash
  node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
  ```
- `ALLOWED_ORIGINS` — comma-separated allowed CORS origins. Blank for local dev.
- `APP_TIMEZONE` — optional, defaults to `Asia/Kolkata`. Used for "today"/
  "now" in attendance check-in/out and birthday calculations — set this if
  the company isn't in India, so join dates and check-in times aren't off
  by the difference between the server's UTC clock and local time.
- `SMTP_*` / `CONTACT_TO` — optional; the contact form works without them.

## 3. Seed and run locally

```bash
npm run db:seed   # creates admin / manager1 / hr1 / emp1 — see seed.js for passwords
npm test          # 47 tests: unit + route-level, no live DB needed
npm run dev       # http://localhost:3000
```

**Change every seeded password immediately** via Settings → Change Password.

To use the new employee/attendance/leave/payroll features, first link a
login to an employee record: edit the employee (`PUT /api/employees/:id`
with `{"user_id": "emp1"}`) or set it directly in the Employees tab once a
"login user" field is added to that form — `GET /api/users/options` already
returns the dropdown data for that.

## 4. Push to GitHub

```bash
git init && git add . && git commit -m "LeoMox HRMS — verified & enhanced backend"
git branch -M main
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```
`.env` is gitignored — never commit it.

## 5. Deploy to Render

**Blueprint:** "New +" → "Blueprint" → point at your repo; `render.yaml` is
included. Fill in `DATABASE_URL`, `ALLOWED_ORIGINS`, and optional `SMTP_*`
in the dashboard (marked `sync: false` in the blueprint).

**Manual:** "New +" → "Web Service" → Node runtime → build `npm install` →
start `npm start`. Add the same env vars as above, plus `NODE_ENV=production`.

After first deploy, run `npm run db:migrate` once against the production
`DATABASE_URL` (locally, with `.env` pointed at production, or as a one-off
Render Job), then `npm run db:seed` the same way.

## Notes / known limitations

- **Employee IDs and local-cache updates:** `editEmployee(id)` in
  `index.html` passes the employee id as a *string* from the onclick
  attribute, but the server returns it as a *number* (Postgres `SERIAL`).
  The line that tries to patch the row in place after a successful edit
  (`arr.findIndex(x => x.id === id)`) will not match, so the edited row
  won't visually update until the page is next reloaded. This is pre-existing
  in the original `index.html` — the edit itself succeeds against the API —
  and wasn't touched since the file must stay unmodified.
- **Client-side permission model:** module visibility (`can('module')`) is
  enforced entirely in `index.html`'s `HRMS.roles` map, not by hiding data
  from the API — `/api/bootstrap` sends the full employees/invoices/users
  lists to every logged-in role because the Dashboard needs them. This
  mirrors the original app's design; a determined user could read
  more than the UI shows them via browser dev tools. Tightening this would
  require changing `index.html`'s data flow, which is out of scope here.
- **Payroll/Leave/Attendance-detail/Dashboard UI:** fully working APIs,
  no screens yet. The current Payroll tab still does its own client-side
  arithmetic from the basic employee list and doesn't call these endpoints.

## Frontend catch-up (this pass)

Your screenshots showed the deployed site still running the original
8-field Employee form and basic dashboard, even though the database (via
`migrate.sql`) already had bank details, statutory info, salary
structures, leave types/balances/requests, and payroll tables sitting
unused — the backend from the previous pass could read/write all of it,
but `public/index.html` had no UI for any of it yet. This pass wires the
frontend up to everything the backend already supports:

- **Employees** — the Add/Edit form now covers the full profile (gender,
  DOB, blood group, marital status, employment type, work mode, reporting
  manager, notice period, address, emergency contact, and linking a login
  user for self-service). Each employee row gets two new action buttons —
  🏦 **Bank Details** and 🪪 **Statutory (PAN/PF/ESI)** — opening their own
  small forms that save straight to `employee_bank`/`employee_statutory`.
- **Attendance** — the status dropdown now offers all 8 states (was 4:
  Present/Absent/Half Day/Leave; now adds Holiday/Weekly Off/Work From
  Home/On Duty), there's a "Mark all Present" quick-fill button, and any
  logged-in user with a linked employee record gets a **Check In / Check
  Out** card with real timestamps.
- **Leave** (new tab) — leave balances by type, an Apply for Leave form,
  a requests list with Cancel, and a two-stage Manager → HR approval queue
  for staff roles. Approved leave automatically appears as `Leave` (or
  unpaid LOP) in that employee's attendance, which payroll then picks up.
- **Payroll** — replaced the old client-side 20%/12% approximation with
  the real thing: a month/year picker, **Generate Payroll** (admin/HR),
  **Approve All** and **Lock Month** (admin), a preview table showing real
  LOP days and net pay per employee, and a proper payslip that pulls bank
  details, PAN/PF numbers, and leave balance from the database instead of
  showing "---" placeholders. Employees without payroll access now see a
  **My Payslips** list of just their own published payslips.
- **Dashboard** — added upcoming-birthdays and new-joiners widgets (all
  roles), plus department headcount, today's attendance breakdown, pending
  leave count, and who's on approved leave today (staff roles).
- **Notifications** — a 🔔 bell in the header with an unread badge and a
  dropdown, backed by the `notifications` table.
- **Audit Log** — a read-only table under Settings, admin only.

### ⚠️ Run the migration before using any of this

`payroll.paid_days`/`lop_days` were defined as `INTEGER` in `migrate.sql`,
but half-day leave or a half-day absence needs `0.5`. `migrate_v2.sql`
widens both to `NUMERIC(5,1)` — **without it, generating payroll for a
month that includes any half-day will fail with a database error.** Since
your database already has the Phase 1–8 tables from `migrate.sql`, you
only need to apply the new one:
```bash
npm run db:migrate
```
This re-runs all three files, but every statement is idempotent, so
nothing already in place is touched or duplicated — it will just apply the
handful of new statements in `migrate_v2.sql` (column type changes, a few
`ON DELETE SET NULL` foreign key fixes, and two unique constraints).

### What's unchanged on purpose

Employee create/edit/delete (and the new Bank/Statutory buttons) are still
gated to the **admin** role only in the UI, matching the original app's
`can('users')` check — even though the backend already allows HR too. The
per-permission catalog visible in your Supabase/Neon screenshot (30+ rows
like `payroll.approve`, `leave.manage_policy`) isn't surfaced as a granular
UI yet; role→module access is still the same coarse mapping in
`HRMS.roles`, just with `leave` and (for admin/HR/employee) `payroll`
added to it. Building a full per-user permission editor against that
catalog would be a good next step if you want finer control than the
current 4 fixed roles.
