# LeoMox IT Solutions — Dynamic Website + HRMS

A full-stack conversion of the original static site: Express + Neon Postgres
backend, real bcrypt/JWT auth, and a frontend that talks to a real API
instead of the browser's `localStorage`.

```
leomox-app/
├── server/           Express API (Node.js)
│   ├── server.js
│   ├── db.js
│   ├── schema.sql        ← run this against Neon once
│   ├── seed.js            ← run this once, after schema.sql
│   ├── middleware/auth.js
│   ├── routes/*.routes.js
│   ├── package.json
│   └── .env.example
└── public/           Static frontend, served by the same Express app
    ├── index.html
    └── illustrations/*.svg
```

---

## 1. Create the Neon database

1. Sign up / log in at **https://neon.tech** and create a new project.
2. In the Neon dashboard, open **Connection Details** and copy the connection
   string (it looks like `postgresql://user:password@ep-xxxx.neon.tech/neondb?sslmode=require`).
   Either the direct or the "pooled" (`-pooler`) connection string works fine
   with this app.
3. Keep that string handy for step 3.

## 2. Apply the schema

From the `server/` folder, with `psql` installed locally:

```bash
psql "postgresql://user:password@ep-xxxx.neon.tech/neondb?sslmode=require" -f schema.sql
```

No local `psql`? Paste the contents of `schema.sql` into the **SQL Editor** in
the Neon dashboard and run it there instead — same effect.

This creates the `users`, `employees`, `attendance`, `invoices`,
`site_content`, and `contact_requests` tables, and inserts the default public
site copy (hero text, address, phone, email, etc.).

## 3. Configure environment variables

```bash
cd server
cp .env.example .env
```

Edit `.env`:

- `DATABASE_URL` — the Neon connection string from step 1.
- `JWT_SECRET` — generate one with:
  ```bash
  node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
  ```
- `PORT` — defaults to 3000; most hosting platforms override this
  automatically, that's fine.
- `NODE_ENV` — set to `production` when deploying live.

## 4. Install dependencies and seed default accounts

```bash
cd server
npm install
npm run db:seed
```

This creates four default login accounts (bcrypt-hashed, never plaintext):

| User ID    | Password     | Role     |
|------------|--------------|----------|
| `admin`    | `leomox@123` | admin    |
| `manager1` | `mgr@123`    | manager  |
| `hr1`      | `hr@123`     | hr       |
| `emp1`     | `emp@123`    | employee |

**Change these immediately after your first login** — go to
`HRMS → Settings → Change Password` once logged in as `admin`. There's no
admin-panel button to change *other* users' passwords by ID without knowing
their current one; use `HRMS → Users → edit` (as admin) to set a new password
for someone else if needed.

## 5. Run it locally

```bash
cd server
npm start
```

Visit `http://localhost:3000` — this serves both the public website and the
API from one process (the API lives under `/api/*`; everything else falls
back to `public/index.html`, which is how the single-page routing works).

For local development with auto-restart on file changes:
```bash
npm run dev
```

---

## Deploying it live

Any Node-hosting platform works since this is a normal Express app (not
tied to serverless-only APIs). Two straightforward options:

### Option A — Render.com (simplest)

1. Push this project to a GitHub repo.
2. On Render: **New → Web Service**, connect the repo.
3. **Root Directory:** `server`
   **Build Command:** `npm install`
   **Start Command:** `npm start`
4. Add environment variables (`DATABASE_URL`, `JWT_SECRET`, `NODE_ENV=production`)
   under the service's **Environment** tab.
5. Deploy. Render gives you a `https://your-app.onrender.com` URL immediately;
   point your custom domain at it via a CNAME once you're ready.
6. Run the seed script once against production — either temporarily add
   `npm run db:seed` as a one-off Render "Shell" command, or run it locally
   with `DATABASE_URL` pointed at the same Neon database.

### Option B — Railway.app

Same idea: new project from GitHub repo, set root directory to `server`,
set the same environment variables, Railway auto-detects `npm start`.

### Custom VPS

```bash
git clone <your-repo>
cd leomox-app/server
npm install --production
cp .env.example .env   # fill in real values
npm run db:seed
# Use pm2 (or systemd) to keep it running:
npx pm2 start server.js --name leomox
npx pm2 save
```
Put Nginx or Caddy in front of it for TLS/HTTPS termination and your domain.

---

## What actually changed from the static version

- **Auth**: bcrypt password hashing + JWT httpOnly session cookies, server-
  enforced rate limiting on login (10 attempts/15 min per IP) — none of this
  can be bypassed by refreshing the page or clearing browser storage, unlike
  the old client-only version.
- **Data**: employees, users, invoices, site content, and contact-form leads
  all live in Postgres now, not the visitor's own browser. Multiple admins
  on different devices see the same data.
- **Roles**: every API endpoint enforces role permissions server-side
  (admin / manager / hr / employee), not just hidden in the UI.
- **"Forgot Password"**: the old flow let anyone reset *any* account's
  password just by typing its User ID — a real account-takeover hole once
  this is reachable on the open internet. It's been replaced with a
  "contact an administrator" message, plus a proper authenticated
  **Change Password** option in Settings. If you later add an email
  provider (e.g. Resend, SendGrid), `routes/auth.routes.js` is the right
  place to add a token-based reset-by-email flow.
- **Attendance**: now actually persists (`POST /api/attendance/mark`)
  instead of being a cosmetic form with no save action.

## Extending it further

- **Email notifications** for new contact-form leads: add a provider (Resend,
  SendGrid, etc.) and call it from `routes/contact.routes.js` after the
  insert.
- **File uploads** (e.g. employee photos): Neon doesn't store files — pair it
  with an object store like Cloudflare R2 or AWS S3 and save just the URL in
  Postgres.
- **Custom domain + HTTPS**: handled automatically by Render/Railway; on a
  VPS, use Caddy for zero-config HTTPS or Nginx + Certbot.
