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

## Chatbot & "dynamic content" audit (this pass)

Your screenshots prompted a check of whether the public site actually
reflects admin-edited content everywhere it should — the answer was
**partially**: the Contact page cards and footer phone/email already
updated correctly, but several other spots were silently hardcoded and
would never change no matter what was saved under Website → Contact &
Company Info. Found and fixed:

- **The chatbot's knowledge base was the main culprit.** `CHAT_KB` was a
  static array built once with literal strings (`+91 9491401514`,
  `info@leomox.in`, the office address, "99.9% uptime | 2M+ delivered |
  10+ clients", etc.) baked into ~12 reply templates. Worse, because the
  catch-all `contact` entry's keyword list (`contact`, `phone`, `support`,
  `help`, `address`, ...) scored higher than the newer dynamic lookups for
  several of those same words, **clicking the "📞 Contact" quick-reply
  button specifically returned the old hardcoded info even when a newer
  dynamic path existed for narrower queries like "phone" alone.** `CHAT_KB`
  is now `buildChatKB(siteContent)`, rebuilt fresh on every message, so
  every reply — not just the few already-dynamic ones — reflects whatever
  is currently saved, and the scoring-precedence quirk stops mattering
  because both paths now produce the same correct answer either way.
- **The floating WhatsApp button** (bottom-right bubble) linked to a fixed
  `wa.me/919491401514` regardless of the saved phone number. Now updates
  from the same `phone` field as everything else.
- **The footer address** and the **Contact page's embedded Google Map**
  (iframe + "Open in Google Maps" link) had no `id` at all, so
  `applyWebsiteContent()` could never touch them — they'd show the
  original launch address forever. Both are now wired in.
- **Payslip and invoice print letterheads** showed a hardcoded "LeoMox IT
  Solutions" name/address/email/phone rather than the configured company
  info — fixed to pull from the same source.

None of this needs a new database column or a backend change — every
field used here (`company_name`, `phone`, `email`, `address`,
`working_hours`, `about_description`, `stat_*`) already existed in
`site_content` and was already editable from the Website tab; it just
wasn't being *read* consistently on the public-facing side. A page reload
isn't even required after saving — `HRMS.siteContent` is updated in memory
the moment Save succeeds, so the very next chatbot message already reflects it.

## Leave page empty-state (this pass)

The Leave tab's request table rendered as a bare header with no rows and
no indication why when there were zero requests yet (as in a fresh
install) — now shows a plain-language message ("You have no leave
requests yet…" / "No leave requests have been submitted yet.") instead of
a confusing blank table. Also worth knowing: the **Admin** account shown
in your screenshots isn't linked to an employee record (that's done via
the "Login User" dropdown on an employee's profile), which is why it sees
no "+ Apply for Leave" button or balance cards — that's expected, not a bug.

## Social media buttons & Users-tab employee linking (this pass)

**Found and fixed a real bug:** the page has a generic "in-page anchor
router" that runs once at load, attaching a click handler to every
`<a href="#">` that lacks its own `onclick`. The four footer social icons
(Facebook/Instagram/LinkedIn/YouTube) matched that selector because they
start as `href="#"` placeholders until an admin saves a real URL. That
handler calls `e.preventDefault()` unconditionally — so even after
`applyWebsiteContent()` later updated the icon's `href` to a real external
URL, the click was still being swallowed by the leftover listener from
page load, and the browser's normal "follow this link" behavior never
ran. Clicking a social icon looked like it did nothing. Fixed by excluding
`.footer-social-icon` from that router's selector. (The floating WhatsApp
button and the portal login buttons were not affected — they never start
with a bare `#`, so this particular bug didn't apply to them.)

**Added:** a "Linked Employee" column on the Users tab with a one-click
🔗 **Link to employee** / ✖ **Unlink** action, so connecting a login to an
employee record (which is what turns on leave/attendance/payslip
self-service for that account) can be done from either direction —
Users → pick an employee, or Employees → pick a login — instead of only
the latter.

### About your screenshot

Swetha's Leave tab correctly showed "No employee record is linked to your
login yet" — that's the app working as designed, not a bug: her `employees`
row simply hasn't been connected to her `swetha` login yet. Fix it from
either tab: **Users → find `swetha` → 🔗 Link to employee** (new this
pass), or **Employees → edit her profile → Login User → swetha → Save**.
Once linked, her login immediately gets leave balances/apply, check-in/out,
the attendance calendar, and payslip downloads — all three were already
built (see the next section) and just need that one link made per employee.

## What was already in place (confirmed working, not new this pass)

Re-reading your message against the current code, these three were already
fully built in an earlier round and just needed verifying, not building:
- **Leave via employee login**, with the Manager → HR two-step approval
  queue and a "Tracking" column showing exactly which stage a request is
  at and the rejection reason if declined — visible in the employee's own
  "My Requests" table, not just to HR/Manager.
- **Payslip download by calendar year/month**, bounded from the employee's
  actual joining month through the current month — a dedicated selector
  above their payslip history, not just a flat list. ("Download" opens the
  payslip and triggers the browser print dialog; choosing "Save as PDF"
  there is how it's saved to disk — there's no separate PDF-generation
  step on the server.)
- **Attendance calendar with hover popover** — a month grid with a colored
  dot per day; hovering any date pops up that day's status, check-in time,
  and check-out time, with Prev/Next month navigation.

All three were syntax-checked and cross-referenced against their backend
routes again as part of this pass to make sure they're still intact.

## Invoice print & payment-status reliability (this pass)

**Print:** `openDoc()` (used by both Invoice Print and the payslip viewer)
previously wrote the document into a hidden, off-screen iframe
(`position:fixed;top:-9999px;visibility:hidden`) and called `.print()` on
it, falling back to `window.open()` only if that threw. Two real problems
with that: (1) several browsers either refuse to print hidden/off-screen
iframe content, or print a blank page, because it was never actually laid
out on-screen; (2) the fallback `window.open()` ran from inside an async
`iframe.onload` callback, outside the original click's "user gesture"
window — so if it ever did fall back, popup blockers silently swallowed it
with no error shown. `openDoc()` now opens a real new tab directly and
synchronously, right in the click handler, and writes the document into
it. Both templates already have their own visible "Print / Save as PDF"
button once that tab opens. If the tab is still blocked for some reason,
it now falls back to an actual file download instead of a silent no-op,
with an on-screen explanation.

**Payment status:** read through and re-simulated `toggleInvStatus()` and
the backend's `PUT /api/invoices/:id` directly with realistic data (see
below) — no bug found in that logic itself; the PUT payload and backend
handling are both correct. What *was* a real problem: `apiFetch()` handled
an expired session (401) by silently clearing the logged-in user in the
background with no visible feedback — so if your token had expired
mid-session, clicking Mark Paid would fail, but the only sign was
whatever `alert()` the calling code happened to show, and the screen
behind it stayed exactly as it was. It now redirects straight to the login
screen with a clear "Your session has expired" message, so an expired
session is never mistaken for "this button is broken."

If Mark Paid still doesn't persist after this update, the most likely
explanation now is that the deployed server isn't running the latest
`routes/invoices.routes.js` yet — worth confirming the Render deploy
picked up this version, and checking the browser console / Network tab
for the actual PUT request's response on a click.

## Quotation & Invoice Business Module (this pass)

A full quotation-to-invoice workflow with centralized company/bank settings
and server-authoritative GST math, built on top of the existing simple
Invoice module **without changing any of its existing behavior**.

### Files changed / added
**New:**
- `migrate_v3.sql` — new tables + additive invoice columns (see below)
- `utils/billing.js` — the GST calculation engine (pure, unit-tested)
- `routes/quotations.routes.js` — quotation CRUD, status workflow, convert
- `routes/companySettings.routes.js` — GET/PUT the singleton settings row
- `tests/billing.test.js` (14 tests), `tests/quotations.test.js` (18 tests)

**Modified (additive only):**
- `routes/invoices.routes.js` — 4 new routes appended at the end of the
  file; the original `GET/POST/PUT/DELETE /api/invoices[/:id]` handlers
  are byte-for-byte unchanged above them
- `server.js` — 2 new `app.use()` mount lines
- `scripts/migrate.js` — now also applies `migrate_v3.sql`
- `package.json` — `npm test` now also runs the two new test files
- `public/index.html` — see "Frontend" below; the original invoice
  form/table/print function are unmodified, only extended

### Database migrations (`migrate_v3.sql`, run via `npm run db:migrate`)
- **`company_settings`** — one-row table (id=1): legal/bank/GST info,
  invoice & quotation number prefixes/counters, default CGST/SGST/IGST
  rates, default terms & conditions. Auto-seeded with sensible defaults.
- **`quotations`** + **`quotation_items`** — full quotation header and
  line items, matching the spec's field list exactly.
- **`invoices`** — 22 new nullable columns added (`invoice_number`,
  `quotation_id`, customer/PO/salesperson fields, and the GST totals
  `subtotal`/`discount_total`/`taxable_amount`/`cgst`/`sgst`/`igst`/
  `round_off`/`grand_total`). The existing `items` JSONB column, its data,
  and every existing row are untouched. The `status` CHECK constraint is
  widened to add `Draft/Sent/Viewed/Partially Paid` alongside the four
  values already in use.
- **`invoice_items`** — rich line items, parallel to the legacy `items`
  JSONB. Only populated for invoices created via the new full form or a
  quotation conversion; a legacy simple invoice has no rows here and keeps
  working entirely off its `items` JSONB exactly as before.

### API endpoints
**New:**
| Method | Path | Notes |
|---|---|---|
| GET/PUT | `/api/company-settings` | GET: admin+manager · PUT: admin only |
| GET | `/api/quotations` / `/api/quotations/:id` | admin+manager |
| POST | `/api/quotations` | creates a Draft; server computes all totals |
| PUT | `/api/quotations/:id` | Draft only — locked once Sent or further |
| PUT | `/api/quotations/:id/status` | enforces the status workflow (admin can force) |
| DELETE | `/api/quotations/:id` | Draft only |
| POST | `/api/quotations/:id/convert` | Accepted → new Invoice; quotation flips to Converted |
| GET | `/api/invoices/:id/full` | invoice + rich items + company settings + amount-in-words |
| POST | `/api/invoices/full` | create a rich invoice directly (no quotation) |
| PUT | `/api/invoices/:id/full` | edit a rich invoice; locked once Paid/Cancelled |
| PUT | `/api/invoices/:id/status` | the widened 8-value status set |

**Unchanged:** every existing `/api/invoices` route (confirmed via two
explicit regression tests in `tests/quotations.test.js` that exercise the
original simple create and Mark Paid toggle through the untouched code path).

### Frontend pages/components added
All inside the existing **Invoices** tab (no new nav entry, no new
permission — reuses the existing admin+manager `invoice` permission):
- **"+ New Quotation"** button next to "+ New Invoice"
- A **Quotations** section below the existing invoice table: list with
  status badges, and status-appropriate actions (Edit/Mark Sent/Delete on
  Draft; Accepted/Rejected on Sent; Convert to Invoice on Accepted)
- The **Quotation form**: all three field groups from the spec (Quotation
  Details, Customer Details, Line Items) plus the full Commercial
  Information section (scope of work, deliverables, payment schedule,
  warranty/AMC, etc.), with a live-recalculating line-items editor
  (add/remove rows, per-line discount %/tax %/tax type) and a totals
  preview — the preview is cosmetic only; the server recomputes and stores
  the authoritative figures on save
- **Company Settings → Billing** card under Settings (admin only): company
  info, bank details, invoice/quotation numbering, default GST rates and terms
- The existing invoice table now shows the real `invoice_number` (e.g.
  `INV-2026-0001`) and a "from QTN" badge for converted invoices, and
  switches its Amount/GST/Total columns to the server-computed figures for
  rich invoices while legacy invoices display exactly as before

### PDF changes
- **Quotation PDF** (`printQuotation`) — new, matching the spec's layout:
  header with company info, customer details, line items with HSN/SAC and
  discount/tax columns, commercial terms, totals with amount in words,
  bank details (from Company Settings), terms & conditions, and a
  customer-acceptance/signature block.
- **Invoice PDF** (`printInvoice`) — now branches: a legacy invoice (no
  `invoice_number`) renders through the *exact same code as before*; a
  rich invoice renders a new, fuller layout with HSN/SAC, discount, and a
  real CGST/SGST/IGST breakdown, bank details and terms pulled from
  Company Settings instead of being hard-coded, and a "Reference
  Quotation" line when converted from one.

### Tests added
32 new tests, all passing (`npm test` runs 79 total across every suite):
- `tests/billing.test.js` (14) — the GST engine: intra-/inter-state tax
  split, discount-by-percent vs discount-by-amount, Exempt/None handling,
  rate defaulting, validation (bad qty/rate/discount/tax rejected, not
  silently clamped), multi-item rounding reconciliation, document-number
  formatting, Indian-numbering amount-in-words.
- `tests/quotations.test.js` (18) — route-level: role gating (manager-tier
  only, not HR), status-transition enforcement, **server ignores a spoofed
  `grand_total` in the request body and stores its own computed value**,
  edit/delete locked outside Draft, full convert-to-invoice flow, and two
  explicit regression tests proving the original simple invoice endpoints
  are byte-for-byte unaffected.

### Environment variables required
**None.** Everything uses the existing `DATABASE_URL`/`JWT_SECRET` setup;
no new service, API key, or config value is needed.

### Migration / run instructions
```bash
npm install          # no new dependencies were added
npm run db:migrate    # applies migrate_v3.sql (and re-applies v1/v2 — both no-ops by now)
npm test              # 79 tests, no live DB needed
npm run dev
```
Then, as **admin**: Settings → Company Settings — Billing, and fill in at
least the legal name, GSTIN, and bank details before issuing real
documents (everything works with the seeded defaults in the meantime, just
with blank/placeholder bank details on the PDF until set).

### Known scope decisions (read before assuming something's missing)
- **"Send to Customer"** is implemented as the **Mark Sent** status action,
  not actual email delivery — there's no SMTP-sending of the PDF itself.
  Wiring the existing `nodemailer` setup (already used for contact-form
  notifications) to email the generated document as an attachment would be
  the natural next step if needed.
- **"Preview"** and **"Download PDF"** are the same action (**Print**),
  matching how the original invoice already worked: it opens the formatted
  document in a new tab (the preview) with its own "Print / Save as PDF"
  button, rather than a separate preview modal plus a separate download.
- Quotation **editing is Draft-only** by design (rule: a quotation that's
  already been shown to a customer shouldn't silently change); Rejected/
  Expired quotations can be moved back to Draft to revise and resend.
- I was not able to generate a real quotation/invoice against a live
  database in this sandbox (no network access here) — the 79 passing tests
  cover the calculation engine and every route's logic against a fake DB,
  but a first real run-through (create quotation → accept → convert →
  print both PDFs) after deploying is still worth doing deliberately.

## Follow-up fix: direct Full Invoice creation (same pass, continued)

Spotted a gap against the spec right after the above: the backend's
`POST /api/invoices/full` and `PUT /api/invoices/:id/full` were built and
tested, but nothing in the UI actually reached them — only converting a
quotation produced a rich invoice. Added:

- **"+ New Full Invoice"** button next to "+ New Quotation", opening the
  rich invoice form (Invoice Information, Customer Information, the same
  line-items editor) directly, with no quotation required.
- An **✏️ Edit** action on rich invoices in the table (previously they
  could only be printed or toggled Paid/Pending).

Reused the Quotation form's line-items editor for this rather than writing
a second copy — the GST math and fields are identical for both document
types. Doing that surfaced a real scoping bug worth calling out: the editor
is driven by a shared CSS class (`.quo-item-row`) and a couple of its
functions (`recalcQuoTotals`, `readQuoItems`) originally fell back to
scanning the *entire document* when called without an explicit container
id. Since both forms can end up in the DOM at once (closing a form only
hides it with `display:none`, it doesn't remove its content), a bare call
from one form's inline `oninput` handler could silently sum in rows
belonging to the *other* form. Fixed by having every row's inline handler
resolve its own tbody id via `this.closest('tbody').id` rather than relying
on a fallback, and verified by extracting the actual functions and running
them against a mock DOM with both containers populated simultaneously —
each now correctly totals only its own rows regardless of what else is open.
