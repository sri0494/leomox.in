# LeoMox IT Solutions — Website Deployment

Full-stack website with HRMS admin portal.  
**Stack:** Node.js + Express · Neon PostgreSQL · Vanilla JS SPA

---

## Project Structure

```
leomox-website/
├── server.js              ← Express entry point
├── db.js                  ← Neon DB connection + schema bootstrap
├── package.json
├── .env.example           ← Copy to .env and fill in values
├── .gitignore
├── middleware/
│   └── auth.js            ← JWT auth middleware
├── routes/
│   ├── auth.js            ← /api/auth/* (login, logout, me, change-password)
│   ├── users.js           ← /api/users/* (admin CRUD)
│   ├── employees.js       ← /api/employees/*
│   ├── attendance.js      ← /api/attendance/*
│   ├── invoices.js        ← /api/invoices/*
│   ├── contact.js         ← /api/contact/* (public form + admin view)
│   └── siteContent.js     ← /api/site-content (website settings)
└── public/
    └── index.html         ← Full website SPA
```

---

## Local Development

```bash
# 1. Install dependencies
npm install

# 2. Create environment file
cp .env.example .env
# Edit .env with your Neon DB URL, JWT secret, etc.

# 3. Start dev server (auto-restart on changes)
npm run dev

# 4. Open http://localhost:3000
```

---

## Deploy to Render.com

1. Push this folder to a **GitHub repository**
2. Go to [render.com](https://render.com) → **New Web Service**
3. Connect your GitHub repo
4. Settings:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Node Version:** 18+
5. Add **Environment Variables** (from your `.env`):
   - `DATABASE_URL` — your Neon connection string
   - `JWT_SECRET` — random 64-char hex string
   - `NODE_ENV` — `production`
   - `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` — for contact form emails
   - `CONTACT_EMAIL` — where enquiry notifications go
   - `ALLOWED_ORIGINS` — `https://yourdomain.com`
   - `SEED_ADMIN_ID`, `SEED_ADMIN_PASSWORD` — first-run admin credentials
6. Deploy — tables are auto-created on first boot

---

## Deploy to VPS (Ubuntu)

```bash
# Install Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Upload project files to /var/www/leomox
cd /var/www/leomox
npm install --production

# Create .env
nano .env   # paste your values

# Install PM2 process manager
sudo npm install -g pm2
pm2 start server.js --name leomox-website
pm2 save
pm2 startup

# Nginx reverse proxy (replace yourdomain.com)
sudo nano /etc/nginx/sites-available/leomox
```

**Nginx config:**
```nginx
server {
    listen 80;
    server_name yourdomain.com www.yourdomain.com;

    location / {
        proxy_pass         http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection 'upgrade';
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_cache_bypass $http_upgrade;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/leomox /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# SSL (free via Let's Encrypt)
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d yourdomain.com -d www.yourdomain.com
```

---

## First Login

After deployment, the server auto-creates an admin account on first boot:

| Field    | Default value (set in .env)       |
|----------|-----------------------------------|
| User ID  | `admin` (SEED_ADMIN_ID)           |
| Password | `leomox@2024` (SEED_ADMIN_PASSWORD)|

**Change the password immediately** after first login via Admin → Settings → Change Password.

---

## Portal URL Management

After login as admin, go to **Admin → Website → Portal URLs** to update:
- **SMS Portal URL** — your separate SMS portal deployment URL
- **Voice Agent URL** — your Voice Agent deployment URL

These are stored in the database and applied live — no redeploy needed when you change portal URLs.

---

## API Reference

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/auth/login` | — | Login |
| GET | `/api/auth/me` | ✓ | Get current user |
| POST | `/api/auth/logout` | — | Logout |
| POST | `/api/auth/change-password` | ✓ | Change own password |
| GET | `/api/users` | admin | List users |
| POST | `/api/users` | admin | Create user |
| PUT | `/api/users/:id` | admin | Update user |
| POST | `/api/users/:id/toggle-active` | admin | Enable/disable user |
| DELETE | `/api/users/:id` | admin | Delete user |
| GET | `/api/employees` | ✓ | List employees |
| POST | `/api/employees` | ✓ | Add employee |
| PUT | `/api/employees/:id` | ✓ | Update employee |
| DELETE | `/api/employees/:id` | ✓ | Delete employee |
| GET | `/api/attendance` | ✓ | List attendance |
| POST | `/api/attendance/mark` | ✓ | Mark attendance |
| GET | `/api/invoices` | ✓ | List invoices |
| POST | `/api/invoices` | ✓ | Create invoice |
| PUT | `/api/invoices/:id` | ✓ | Update invoice |
| DELETE | `/api/invoices/:id` | ✓ | Delete invoice |
| POST | `/api/contact` | — | Submit contact form (public) |
| GET | `/api/contact` | ✓ | List enquiries (admin) |
| PUT | `/api/contact/:id/status` | ✓ | Update enquiry status |
| GET | `/api/site-content` | — | Get website content |
| PUT | `/api/site-content` | admin | Save website content |
| GET | `/api/bootstrap` | — | Initial page load data |
