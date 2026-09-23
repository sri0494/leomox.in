'use strict';
const express  = require('express');
const { sql }  = require('../db');
const { requireAuth } = require('../middleware/auth');
const router   = express.Router();

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

/* POST /api/invoices */
router.post('/', requireAuth, async (req, res) => {
  try {
    const { client, address, gstin, date, due_date, terms, status, items } = req.body;
    if (!client) return res.status(400).json({ error: 'Client name required' });
    const [row] = await sql`
      INSERT INTO invoices (client, address, gstin, date, due_date, terms, status, items)
      VALUES (${client}, ${address||null}, ${gstin||null}, ${date||null}, ${due_date||null}, ${terms||null}, ${status||'Pending'}, ${JSON.stringify(items||[])})
      RETURNING *
    `;
    res.status(201).json(row);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

/* PUT /api/invoices/:id */
router.put('/:id', requireAuth, async (req, res) => {
  try {
    const { client, address, gstin, date, due_date, terms, status, items } = req.body;
    const [row] = await sql`
      UPDATE invoices SET
        client=${client}, address=${address||null}, gstin=${gstin||null},
        date=${date||null}, due_date=${due_date||null}, terms=${terms||null},
        status=${status||'Pending'}, items=${JSON.stringify(items||[])}
      WHERE id = ${req.params.id}
      RETURNING *
    `;
    if (!row) return res.status(404).json({ error: 'Invoice not found' });
    res.json(row);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

/* DELETE /api/invoices/:id */
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    await sql`DELETE FROM invoices WHERE id = ${req.params.id}`;
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

module.exports = router;
