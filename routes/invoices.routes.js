'use strict';
const express = require('express');
const { sql } = require('../db');
const { requireManager } = require('../middleware/auth');
const audit   = require('../utils/audit');

const router = express.Router();
const VALID_STATUS = ['Pending', 'Paid', 'Overdue', 'Cancelled'];

function parseId(raw) {
  const n = Number(raw);
  return Number.isInteger(n) ? n : null;
}

function cleanItems(items) {
  if (!Array.isArray(items)) return null;
  const cleaned = items
    .map(it => ({
      desc: String(it && it.desc || '').trim(),
      qty: Number(it && it.qty) || 0,
      rate: Number(it && it.rate) || 0,
    }))
    .filter(it => it.desc);
  return cleaned.length ? cleaned : null;
}

// GET /api/invoices — the "invoice" module is only in admin/manager's nav
router.get('/', requireManager, async (req, res) => {
  try {
    const rows = await sql`SELECT * FROM invoices ORDER BY created_at DESC`;
    res.json(rows);
  } catch (err) {
    console.error('List invoices error:', err);
    res.status(500).json({ error: 'Failed to load invoices' });
  }
});

// POST /api/invoices
router.post('/', requireManager, async (req, res) => {
  try {
    const { client, addr, gstin, date, due, terms, status, items } = req.body || {};
    const cleanClient = (client || '').trim();
    if (!cleanClient) return res.status(400).json({ error: 'Client name is required' });

    const cleanedItems = cleanItems(items);
    if (!cleanedItems) return res.status(400).json({ error: 'At least one line item is required' });

    const st = VALID_STATUS.includes(status) ? status : 'Pending';

    const rows = await sql`
      INSERT INTO invoices (client, addr, gstin, date, due, terms, status, items)
      VALUES (${cleanClient}, ${addr || null}, ${gstin || null}, ${date || null}, ${due || null}, ${terms || null}, ${st}, ${JSON.stringify(cleanedItems)}::jsonb)
      RETURNING *
    `;
    await audit.log(req, { action: 'create', module: 'invoices', recordId: rows[0].id, newValue: rows[0] });
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('Create invoice error:', err);
    res.status(500).json({ error: 'Failed to create invoice' });
  }
});

// PUT /api/invoices/:id — used both for full edits and for the
// Paid/Pending status toggle (client sends the whole invoice object back
// with just `status` changed).
router.put('/:id', requireManager, async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Invalid invoice id' });

    const rows0 = await sql`SELECT * FROM invoices WHERE id = ${id}`;
    const existing = rows0[0];
    if (!existing) return res.status(404).json({ error: 'Invoice not found' });

    const { client, addr, gstin, date, due, terms, status, items } = req.body || {};
    const cleanClient = client !== undefined ? String(client).trim() : existing.client;
    if (!cleanClient) return res.status(400).json({ error: 'Client name is required' });

    const st = status !== undefined ? (VALID_STATUS.includes(status) ? status : existing.status) : existing.status;
    const cleanedItems = items !== undefined ? (cleanItems(items) || existing.items) : existing.items;

    const rows = await sql`
      UPDATE invoices SET
        client = ${cleanClient},
        addr   = ${addr !== undefined ? addr : existing.addr},
        gstin  = ${gstin !== undefined ? gstin : existing.gstin},
        date   = ${date !== undefined ? (date || null) : existing.date},
        due    = ${due !== undefined ? (due || null) : existing.due},
        terms  = ${terms !== undefined ? terms : existing.terms},
        status = ${st},
        items  = ${JSON.stringify(cleanedItems)}::jsonb
      WHERE id = ${id}
      RETURNING *
    `;
    await audit.log(req, { action: 'update', module: 'invoices', recordId: id, oldValue: existing, newValue: rows[0] });
    res.json(rows[0]);
  } catch (err) {
    console.error('Update invoice error:', err);
    res.status(500).json({ error: 'Failed to update invoice' });
  }
});

// DELETE /api/invoices/:id — not currently used by the UI, provided for completeness
router.delete('/:id', requireManager, async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Invalid invoice id' });

    const rows0 = await sql`SELECT id FROM invoices WHERE id = ${id}`;
    if (!rows0.length) return res.status(404).json({ error: 'Invoice not found' });

    await sql`DELETE FROM invoices WHERE id = ${id}`;
    await audit.log(req, { action: 'delete', module: 'invoices', recordId: id });
    res.json({ ok: true });
  } catch (err) {
    console.error('Delete invoice error:', err);
    res.status(500).json({ error: 'Failed to delete invoice' });
  }
});

module.exports = router;
