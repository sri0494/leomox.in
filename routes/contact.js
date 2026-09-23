'use strict';
const express    = require('express');
const nodemailer = require('nodemailer');
const { sql }    = require('../db');
const { requireAuth } = require('../middleware/auth');
const router     = express.Router();

function makeTransport() {
  if (!process.env.SMTP_HOST) return null;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_PORT === '465',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
}

/* POST /api/contact  — public, saves enquiry + sends email notification */
router.post('/', async (req, res) => {
  try {
    const { firstname, lastname, mobile, email, company, service, message } = req.body;
    if (!firstname || !mobile) return res.status(400).json({ error: 'Name and mobile are required' });

    const [row] = await sql`
      INSERT INTO contacts (firstname, lastname, mobile, email, company, service, message)
      VALUES (${firstname}, ${lastname||null}, ${mobile}, ${email||null}, ${company||null}, ${service||null}, ${message||null})
      RETURNING *
    `;

    // Send email notification (non-blocking — don't fail the request if email fails)
    const transport = makeTransport();
    if (transport && process.env.CONTACT_EMAIL) {
      transport.sendMail({
        from: process.env.SMTP_USER,
        to:   process.env.CONTACT_EMAIL,
        subject: `New Enquiry — ${firstname} ${lastname || ''} (${service || 'General'})`,
        html: `
          <h2>New Contact Enquiry — LeoMox</h2>
          <table>
            <tr><td><b>Name</b></td><td>${firstname} ${lastname||''}</td></tr>
            <tr><td><b>Mobile</b></td><td>${mobile}</td></tr>
            <tr><td><b>Email</b></td><td>${email||'—'}</td></tr>
            <tr><td><b>Company</b></td><td>${company||'—'}</td></tr>
            <tr><td><b>Service</b></td><td>${service||'—'}</td></tr>
            <tr><td><b>Message</b></td><td>${message||'—'}</td></tr>
          </table>
        `
      }).catch(err => console.error('Email error:', err));
    }

    res.status(201).json({ ok: true, id: row.id });
  } catch (err) {
    console.error('Contact form error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/* GET /api/contact — admin: list all enquiries */
router.get('/', requireAuth, async (req, res) => {
  try {
    const rows = await sql`SELECT * FROM contacts ORDER BY created_at DESC`;
    res.json(rows);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

/* PUT /api/contact/:id/status — admin: update status */
router.put('/:id/status', requireAuth, async (req, res) => {
  try {
    const { status } = req.body;
    const [row] = await sql`UPDATE contacts SET status = ${status} WHERE id = ${req.params.id} RETURNING *`;
    res.json(row);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

/* DELETE /api/contact/:id */
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    await sql`DELETE FROM contacts WHERE id = ${req.params.id}`;
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

module.exports = router;
