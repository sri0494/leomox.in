'use strict';
const express = require('express');
const { sql } = require('../db');
const { requireManager } = require('../middleware/auth');
const audit   = require('../utils/audit');

const router = express.Router();
const VALID_STATUS = ['New', 'Contacted', 'Closed'];

function parseId(raw) {
  const n = Number(raw);
  return Number.isInteger(n) ? n : null;
}

// Lazily build a nodemailer transport only if SMTP is actually configured.
// The contact form must keep working even with no email set up at all.
let _transporter;
function getTransporter() {
  if (_transporter !== undefined) return _transporter;
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    _transporter = null;
    return _transporter;
  }
  try {
    const nodemailer = require('nodemailer');
    _transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      secure: Number(process.env.SMTP_PORT) === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
  } catch (e) {
    console.error('nodemailer setup failed:', e.message);
    _transporter = null;
  }
  return _transporter;
}

async function notifyByEmail(entry) {
  const transporter = getTransporter();
  if (!transporter || !process.env.CONTACT_TO) return;
  try {
    await transporter.sendMail({
      from: process.env.SMTP_USER,
      to: process.env.CONTACT_TO,
      subject: `New contact request — ${entry.name}`,
      text:
        `Name: ${entry.name}\n` +
        `Mobile: ${entry.mobile}\n` +
        `Email: ${entry.email || '-'}\n` +
        `Service: ${entry.service || '-'}\n` +
        `Company: ${entry.company || '-'}\n\n` +
        `Message:\n${entry.message || '-'}`,
    });
  } catch (e) {
    // Never let an email failure break the contact-form submission itself.
    console.error('Contact notification email failed:', e.message);
  }
}

// POST /api/contact — PUBLIC. Used by both the popup and the full Contact Us page.
router.post('/', async (req, res) => {
  try {
    const { name, mobile, email, service, company, message } = req.body || {};
    const cleanName = (name || '').trim();
    const cleanMobile = (mobile || '').trim();
    const digits = cleanMobile.replace(/[^0-9]/g, '');

    if (!cleanName) return res.status(400).json({ error: 'Name is required' });
    if (digits.length < 10) return res.status(400).json({ error: 'Please enter a valid 10-digit mobile number' });
    if (email && !String(email).includes('@')) return res.status(400).json({ error: 'Please enter a valid email address' });

    const rows = await sql`
      INSERT INTO contact_requests (name, mobile, email, service, company, message)
      VALUES (${cleanName}, ${cleanMobile}, ${email || null}, ${service || null}, ${company || null}, ${message || null})
      RETURNING *
    `;
    notifyByEmail(rows[0]); // fire-and-forget, never blocks the response
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('Contact submit error:', err);
    res.status(500).json({ error: 'Failed to submit your request. Please try again.' });
  }
});

// GET /api/contact — admin/manager only ("Requests" tab)
router.get('/', requireManager, async (req, res) => {
  try {
    const rows = await sql`SELECT * FROM contact_requests ORDER BY created_at DESC`;
    res.json(rows);
  } catch (err) {
    console.error('List contact requests error:', err);
    res.status(500).json({ error: 'Failed to load contact requests' });
  }
});

// PUT /api/contact/:id/status
router.put('/:id/status', requireManager, async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Invalid request id' });
    const { status } = req.body || {};
    if (!VALID_STATUS.includes(status)) return res.status(400).json({ error: 'Invalid status' });

    const rows = await sql`UPDATE contact_requests SET status = ${status} WHERE id = ${id} RETURNING *`;
    if (!rows.length) return res.status(404).json({ error: 'Request not found' });

    await audit.log(req, { action: 'update_status', module: 'contact', recordId: id, newValue: { status } });
    res.json(rows[0]);
  } catch (err) {
    console.error('Update contact status error:', err);
    res.status(500).json({ error: 'Failed to update request' });
  }
});

module.exports = router;
