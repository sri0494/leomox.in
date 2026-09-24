'use strict';
const express = require('express');
const { sql } = require('../db');
const { requireAuth } = require('../middleware/auth');
const router  = express.Router();

/* GET /api/attendance?month=YYYY-MM */
router.get('/', requireAuth, async (req, res) => {
  try {
    const { month } = req.query;
    let rows;
    if (month) {
      rows = await sql`
        SELECT a.*, e.name AS employee_name
        FROM   attendance a
        JOIN   employees  e ON e.id = a.employee_id
        WHERE  TO_CHAR(a.date, 'YYYY-MM') = ${month}
        ORDER  BY a.date DESC, e.name
      `;
    } else {
      rows = await sql`
        SELECT a.*, e.name AS employee_name
        FROM   attendance a
        JOIN   employees  e ON e.id = a.employee_id
        ORDER  BY a.date DESC
        LIMIT  500
      `;
    }
    res.json(rows);
  } catch (err) {
    console.error('Attendance GET error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/* POST /api/attendance/mark
   Body: { employeeId: <integer>, date: "YYYY-MM-DD", status: "Present"|... }
   Frontend sends one record at a time; UPSERT on (employee_id, date). */
router.post('/mark', requireAuth, async (req, res) => {
  try {
    const { employeeId, date, status } = req.body;
    if (!employeeId || !date || !status) {
      return res.status(400).json({ error: 'employeeId, date and status required' });
    }
    const [row] = await sql`
      INSERT INTO attendance (employee_id, date, status, marked_by)
      VALUES (${employeeId}, ${date}, ${status}, ${req.user.id})
      ON CONFLICT (employee_id, date)
        DO UPDATE SET status    = EXCLUDED.status,
                      marked_by = EXCLUDED.marked_by
      RETURNING *
    `;
    res.json(row);
  } catch (err) {
    console.error('Attendance mark error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
