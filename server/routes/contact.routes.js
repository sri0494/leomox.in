'use strict';
const express    = require('express');
const nodemailer = require('nodemailer');
const { sql }    = require('../db');
const { requireAuth } = require('../middleware/auth');
const router     = express.Router();

function makeTransport() {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER) return null;
  return nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port:   parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_PORT === '465',
    auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

/* POST /api/contact  — PUBLIC: submit contact / quick-enquiry form
   Frontend sends: { name, mobile, email, service, company, message } */
router.post('/', async (req, res) => {
  try {
    const { name, mobile, email, service, company, message } = req.body;
    if (!name || !mobile) return res.status(400).json({ error: 'name and mobile are required' });

    const [row] = await sql`
      INSERT INTO contact_requests (name, mobile, email, service, company, message)
      VALUES (
        ${name},
        ${mobile},
        ${email   || null},
        ${service || null},
        ${company || null},
        ${message || null}
      )
      RETURNING *
    `;

    /* Email notification — fire-and-forget, never blocks the response */
    const transport = makeTransport();
    if (transport && process.env.CONTACT_TO) {
      transport.sendMail({
        from:    process.env.SMTP_USER,
        to:      process.env.CONTACT_TO,
        subject: `New Enquiry — ${name} (${service || 'General'})`,
        html: `
          <h2 style="color:#1A1A72">New Contact Enquiry — LeoMox</h2>
          <table cellpadding="6" style="border-collapse:collapse">
            <tr><td><b>Name</b></td><td>${name}</td></tr>
            <tr><td><b>Mobile</b></td><td>${mobile}</td></tr>
            <tr><td><b>Email</b></td><td>${email   || '—'}</td></tr>
            <tr><td><b>Company</b></td><td>${company || '—'}</td></tr>
            <tr><td><b>Service</b></td><td>${service || '—'}</td></tr>
            <tr><td><b>Message</b></td><td>${message || '—'}</td></tr>
          </table>
        `,
      }).catch(err => console.error('Email notification error:', err));
    }

    res.status(201).json({ ok: true, id: row.id });
  } catch (err) {
    console.error('Contact POST error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/* GET /api/contact — ADMIN: list all enquiries */
router.get('/', requireAuth, async (req, res) => {
  try {
    const rows = await sql`SELECT * FROM contact_requests ORDER BY created_at DESC`;
    res.json(rows);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

/* PUT /api/contact/:id/status — ADMIN: update status */
router.put('/:id/status', requireAuth, async (req, res) => {
  try {
    const { status } = req.body;
    if (!['New','Contacted','Closed'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    const [row] = await sql`
      UPDATE contact_requests SET status = ${status}
      WHERE id = ${req.params.id}
      RETURNING *
    `;
    if (!row) return res.status(404).json({ error: 'Request not found' });
    res.json(row);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

/* DELETE /api/contact/:id */
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    await sql`DELETE FROM contact_requests WHERE id = ${req.params.id}`;
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

module.exports = router;
