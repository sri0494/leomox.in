'use strict';
const express = require('express');
const { sql } = require('../db');
const { requireManager, requireAdmin } = require('../middleware/auth');
const audit   = require('../utils/audit');
const hr      = require('../utils/hr');
const billing = require('../utils/billing');
const { pgMessage } = require('../utils/employee');

const router = express.Router();
const VALID_STATUS = ['Pending', 'Paid', 'Overdue', 'Cancelled'];
// The full workflow status set (rule #12). The *simple* endpoints above only
// ever read/write the four original values, so existing calls are completely
// unaffected by this list existing — it's only used by the new rich-invoice
// endpoints below.
const FULL_STATUS = ['Draft', 'Sent', 'Viewed', 'Pending', 'Partially Paid', 'Paid', 'Overdue', 'Cancelled'];

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

/* ═══════════════════════════════════════════════════════════════════════
   Rich invoice workflow — all additive. The routes above (GET/POST/PUT/
   DELETE on the bare /:id path) are the original simple-invoice endpoints
   and are completely untouched; nothing below changes their behavior.
   ═══════════════════════════════════════════════════════════════════════ */

const DATE_FIELDS = ['date', 'due', 'po_date'];
const TEXT_FIELDS_FULL = [
  'contact_person', 'company_name', 'service_address', 'mobile', 'email', 'pan', 'state', 'place_of_supply',
  'po_number', 'reference_number', 'salesperson', 'currency', 'notes', 'terms', 'addr', 'gstin',
];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function getSettings() {
  const rows = await sql`SELECT * FROM company_settings WHERE id = 1`;
  if (!rows.length) throw Object.assign(new Error('Company settings have not been initialized'), { status: 500 });
  return rows[0];
}
async function reserveInvoiceNumber() {
  const rows = await sql`
    UPDATE company_settings SET invoice_next_number = invoice_next_number + 1
    WHERE id = 1 RETURNING invoice_next_number - 1 AS reserved, invoice_prefix, number_digits
  `;
  const r = rows[0];
  return billing.formatDocNumber(r.invoice_prefix, new Date().getFullYear(), r.reserved, r.number_digits);
}

function cleanFullHeader(body) {
  const b = body || {};
  const errors = [];
  const clientName = String(b.client || b.company_name || '').trim();
  if (!clientName) errors.push('Client name is required');
  const out = { client: clientName };
  for (const k of TEXT_FIELDS_FULL) out[k] = b[k] != null ? String(b[k]).trim() || null : null;
  if (!out.currency) out.currency = 'INR';
  for (const k of DATE_FIELDS) {
    const v = b[k];
    if (v === undefined || v === null || v === '') { out[k] = k === 'date' ? hr.todayStr() : null; continue; }
    if (!hr.isValidDate(v)) errors.push(`${k.replace(/_/g, ' ')} is not a valid date`);
    else out[k] = v;
  }
  if (out.due && out.date && out.due < out.date) errors.push('Due date cannot be before the invoice date');
  if (out.email && !EMAIL_RE.test(out.email)) errors.push('Email is not valid');
  return { out, errors };
}

async function loadInvoiceItems(invoiceId) {
  return sql`SELECT * FROM invoice_items WHERE invoice_id = ${invoiceId} ORDER BY position, id`;
}

// GET /api/invoices/:id/full — invoice + its rich line items + the company
// settings needed to render a complete PDF (bank details, GSTIN, terms),
// so the frontend never has to assemble that from three separate calls.
router.get('/:id/full', requireManager, async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Invalid invoice id' });
    const invoice = (await sql`SELECT * FROM invoices WHERE id = ${id}`)[0];
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    const [items, settings, quotation] = await Promise.all([
      loadInvoiceItems(id),
      getSettings(),
      invoice.quotation_id ? sql`SELECT quotation_number FROM quotations WHERE id = ${invoice.quotation_id}` : Promise.resolve([]),
    ]);
    res.json({
      invoice, items, settings,
      amountInWords: billing.amountInWords(invoice.grand_total != null ? invoice.grand_total : 0, invoice.currency),
      quotationNumber: quotation[0] ? quotation[0].quotation_number : null,
    });
  } catch (err) {
    console.error('Get full invoice error:', err);
    res.status(err.status || 500).json({ error: err.message || 'Failed to load invoice' });
  }
});

// POST /api/invoices/full — create a rich invoice directly (not via a
// quotation). Totals are always recomputed here from the submitted items;
// nothing the client calculated is trusted or stored as-is.
router.post('/full', requireManager, async (req, res) => {
  try {
    const { out, errors } = cleanFullHeader(req.body);
    if (errors.length) return res.status(400).json({ error: errors.join('; ') });

    const settings = await getSettings();
    const { errors: itemErrors, items, totals } = billing.computeTotals(req.body && req.body.items, settings, out.place_of_supply);
    if (itemErrors.length) return res.status(400).json({ error: itemErrors.join('; ') });

    const invoiceNumber = await reserveInvoiceNumber();
    const legacyItems = items.map((it) => ({ desc: it.service_name + (it.description ? ' — ' + it.description : ''), qty: it.quantity, rate: it.rate }));
    const f = out;

    const rows = await sql`
      INSERT INTO invoices (
        client, addr, gstin, date, due, terms, status, items,
        invoice_number, contact_person, company_name, service_address, mobile, email, pan, state, place_of_supply,
        po_number, po_date, reference_number, salesperson, currency, notes,
        subtotal, discount_total, taxable_amount, cgst, sgst, igst, round_off, grand_total
      ) VALUES (
        ${f.client}, ${f.addr}, ${f.gstin}, ${f.date}, ${f.due}, ${f.terms || settings.default_payment_terms}, 'Draft', ${JSON.stringify(legacyItems)}::jsonb,
        ${invoiceNumber}, ${f.contact_person}, ${f.company_name}, ${f.service_address}, ${f.mobile}, ${f.email}, ${f.pan}, ${f.state}, ${f.place_of_supply},
        ${f.po_number}, ${f.po_date}, ${f.reference_number}, ${f.salesperson}, ${f.currency}, ${f.notes},
        ${totals.subtotal}, ${totals.discount_total}, ${totals.taxable_amount}, ${totals.cgst}, ${totals.sgst}, ${totals.igst}, ${totals.round_off}, ${totals.grand_total}
      )
      RETURNING *
    `;
    const invoice = rows[0];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      await sql`
        INSERT INTO invoice_items (invoice_id, position, service_name, description, hsn_sac, quantity, unit, rate,
          discount_percent, discount_amount, tax_percent, tax_type, tax_amount, line_total)
        VALUES (${invoice.id}, ${i}, ${it.service_name}, ${it.description}, ${it.hsn_sac}, ${it.quantity}, ${it.unit}, ${it.rate},
          ${it.discount_percent}, ${it.discount_amount}, ${it.tax_percent}, ${it.tax_type}, ${it.tax_amount}, ${it.line_total})
      `;
    }
    await audit.log(req, { action: 'create_full', module: 'invoices', recordId: invoice.id, newValue: { invoice_number: invoiceNumber, grand_total: totals.grand_total } });
    res.status(201).json({ invoice, items });
  } catch (err) {
    console.error('Create full invoice error:', err);
    const m = pgMessage(err);
    res.status(m ? 409 : (err.status || 500)).json({ error: m || err.message || 'Failed to create invoice' });
  }
});

// PUT /api/invoices/:id/full — edit a rich invoice. Locked once Paid or
// Cancelled, same reasoning as payroll locking: a settled financial record
// shouldn't silently change under anyone.
router.put('/:id/full', requireManager, async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Invalid invoice id' });
    const existing = (await sql`SELECT * FROM invoices WHERE id = ${id}`)[0];
    if (!existing) return res.status(404).json({ error: 'Invoice not found' });
    if (['Paid', 'Cancelled'].includes(existing.status)) {
      return res.status(409).json({ error: `An invoice that is already "${existing.status}" can no longer be edited` });
    }

    const { out, errors } = cleanFullHeader(req.body);
    if (errors.length) return res.status(400).json({ error: errors.join('; ') });
    const settings = await getSettings();
    const { errors: itemErrors, items, totals } = billing.computeTotals(req.body && req.body.items, settings, out.place_of_supply);
    if (itemErrors.length) return res.status(400).json({ error: itemErrors.join('; ') });

    const legacyItems = items.map((it) => ({ desc: it.service_name + (it.description ? ' — ' + it.description : ''), qty: it.quantity, rate: it.rate }));
    const f = out;
    await sql`
      UPDATE invoices SET
        client=${f.client}, addr=${f.addr}, gstin=${f.gstin}, date=${f.date}, due=${f.due}, terms=${f.terms},
        items=${JSON.stringify(legacyItems)}::jsonb,
        contact_person=${f.contact_person}, company_name=${f.company_name}, service_address=${f.service_address},
        mobile=${f.mobile}, email=${f.email}, pan=${f.pan}, state=${f.state}, place_of_supply=${f.place_of_supply},
        po_number=${f.po_number}, po_date=${f.po_date}, reference_number=${f.reference_number}, salesperson=${f.salesperson},
        currency=${f.currency}, notes=${f.notes},
        subtotal=${totals.subtotal}, discount_total=${totals.discount_total}, taxable_amount=${totals.taxable_amount},
        cgst=${totals.cgst}, sgst=${totals.sgst}, igst=${totals.igst}, round_off=${totals.round_off}, grand_total=${totals.grand_total},
        updated_at = NOW()
      WHERE id = ${id}
    `;
    await sql`DELETE FROM invoice_items WHERE invoice_id = ${id}`;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      await sql`
        INSERT INTO invoice_items (invoice_id, position, service_name, description, hsn_sac, quantity, unit, rate,
          discount_percent, discount_amount, tax_percent, tax_type, tax_amount, line_total)
        VALUES (${id}, ${i}, ${it.service_name}, ${it.description}, ${it.hsn_sac}, ${it.quantity}, ${it.unit}, ${it.rate},
          ${it.discount_percent}, ${it.discount_amount}, ${it.tax_percent}, ${it.tax_type}, ${it.tax_amount}, ${it.line_total})
      `;
    }
    await audit.log(req, { action: 'update_full', module: 'invoices', recordId: id, newValue: { grand_total: totals.grand_total } });
    const [invoice, freshItems] = await Promise.all([sql`SELECT * FROM invoices WHERE id = ${id}`, loadInvoiceItems(id)]);
    res.json({ invoice: invoice[0], items: freshItems });
  } catch (err) {
    console.error('Update full invoice error:', err);
    res.status(500).json({ error: 'Failed to update invoice' });
  }
});

// PUT /api/invoices/:id/status — the widened workflow status set.
router.put('/:id/status', requireManager, async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Invalid invoice id' });
    const { status } = req.body || {};
    if (!FULL_STATUS.includes(status)) return res.status(400).json({ error: 'Invalid status' });
    const existing = (await sql`SELECT id, status FROM invoices WHERE id = ${id}`)[0];
    if (!existing) return res.status(404).json({ error: 'Invoice not found' });
    if (existing.status === 'Cancelled' && req.user.role !== 'admin') {
      return res.status(409).json({ error: 'A cancelled invoice can only be reopened by an admin' });
    }
    const rows = await sql`UPDATE invoices SET status = ${status}, updated_at = NOW() WHERE id = ${id} RETURNING *`;
    await audit.log(req, { action: 'status', module: 'invoices', recordId: id, oldValue: { status: existing.status }, newValue: { status } });
    res.json(rows[0]);
  } catch (err) {
    console.error('Invoice status error:', err);
    res.status(500).json({ error: 'Failed to update invoice status' });
  }
});

module.exports = router;
