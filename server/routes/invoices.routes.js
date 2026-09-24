'use strict';
const express = require('express');
const { sql } = require('../db');
const { requireAuth, requireManager } = require('../middleware/auth');
const router  = express.Router();

/* GET /api/invoices */
router.get('/', requireAuth, async (req, res) => {
  try {
    const rows = await sql`SELECT * FROM invoices ORDER BY created_at DESC`;
    res.json(rows);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

/* GET /api/invoices/:id */
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const [row] = await sql`SELECT * FROM invoices WHERE id = ${req.params.id}`;
    if (!row) return res.status(404).json({ error: 'Invoice not found' });
    res.json(row);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

/* POST /api/invoices
   Frontend sends: { client, addr, gstin, date, due, terms, status, items } */
router.post('/', requireManager, async (req, res) => {
  try {
    const { client, addr, gstin, date, due, terms, status, items } = req.body;
    if (!client) return res.status(400).json({ error: 'client is required' });
    const [row] = await sql`
      INSERT INTO invoices (client, addr, gstin, date, due, terms, status, items)
      VALUES (
        ${client},
        ${addr   || null},
        ${gstin  || null},
        ${date   || null},
        ${due    || null},
        ${terms  || null},
        ${status || 'Pending'},
        ${JSON.stringify(items || [])}
      )
      RETURNING *
    `;
    res.status(201).json(row);
  } catch (err) {
    console.error('Invoice POST error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/* PUT /api/invoices/:id
   Frontend uses spread: { ...inv, status: newStatus }
   so all original fields come through unchanged. */
router.put('/:id', requireManager, async (req, res) => {
  try {
    const { client, addr, gstin, date, due, terms, status, items } = req.body;
    const [row] = await sql`
      UPDATE invoices SET
        client = ${client           || null},
        addr   = ${addr             || null},
        gstin  = ${gstin            || null},
        date   = ${date             || null},
        due    = ${due              || null},
        terms  = ${terms            || null},
        status = ${status           || 'Pending'},
        items  = ${JSON.stringify(items || [])}
      WHERE id = ${req.params.id}
      RETURNING *
    `;
    if (!row) return res.status(404).json({ error: 'Invoice not found' });
    res.json(row);
  } catch (err) {
    console.error('Invoice PUT error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/* DELETE /api/invoices/:id */
router.delete('/:id', requireManager, async (req, res) => {
  try {
    await sql`DELETE FROM invoices WHERE id = ${req.params.id}`;
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

module.exports = router;
