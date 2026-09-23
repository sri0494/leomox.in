// ============================================================================
// routes/invoices.routes.js
// ============================================================================
const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

function nextInvoiceId(rows) {
    const nums = rows.map(r => parseInt(String(r.id).replace(/\D/g, ''), 10)).filter(n => !isNaN(n));
    const next = (nums.length ? Math.max(...nums) : 1000) + 1;
    return 'INV' + next;
}

router.get('/', requireAuth, async (req, res) => {
    const { rows } = await pool.query('SELECT * FROM invoices ORDER BY created_at DESC');
    res.json(rows);
});

router.post('/', requireAuth, requireRole('admin', 'manager'), async (req, res) => {
    const { client, addr, gstin, date, due, status, terms, items } = req.body || {};
    if (!client) return res.status(400).json({ error: 'Client name is required.' });
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'At least one line item is required.' });

    const { rows: existing } = await pool.query('SELECT id FROM invoices');
    const id = nextInvoiceId(existing);

    const { rows } = await pool.query(
        `INSERT INTO invoices (id, client, addr, gstin, date, due, status, terms, items)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [id, client, addr || '', gstin || '', date || new Date().toISOString().slice(0,10), due || null,
         status || 'Pending', terms || 'Net 30 days', JSON.stringify(items)]
    );
    res.status(201).json(rows[0]);
});

router.put('/:id', requireAuth, requireRole('admin', 'manager'), async (req, res) => {
    const { client, addr, gstin, date, due, status, terms, items } = req.body || {};
    const { rows } = await pool.query(
        `UPDATE invoices SET client=$1, addr=$2, gstin=$3, date=$4, due=$5, status=$6, terms=$7, items=$8, updated_at=now()
         WHERE id=$9 RETURNING *`,
        [client, addr || '', gstin || '', date, due || null, status, terms || 'Net 30 days', JSON.stringify(items || []), req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Invoice not found.' });
    res.json(rows[0]);
});

router.delete('/:id', requireAuth, requireRole('admin', 'manager'), async (req, res) => {
    await pool.query('DELETE FROM invoices WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
});

module.exports = router;
