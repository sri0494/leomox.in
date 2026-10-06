'use strict';
const express = require('express');
const { sql } = require('../db');
const { requireManager, requireAdmin } = require('../middleware/auth');
const audit = require('../utils/audit');
const hr = require('../utils/hr');
const billing = require('../utils/billing');
const { parseIntId, pgMessage } = require('../utils/employee');

const router = express.Router();

const STATUSES = ['Draft', 'Sent', 'Viewed', 'Accepted', 'Rejected', 'Expired', 'Converted'];
// Once a quotation has actually gone out (or further), its commercial
// content is locked — editing it after the fact would silently rewrite
// what the customer was shown. Only a Draft can still be edited/deleted.
const EDITABLE_STATUSES = ['Draft'];
// Legal-ish forward-only status transitions (plus admin can always force
// Draft back for a correction before anything has been sent).
const ALLOWED_TRANSITIONS = {
  Draft: ['Sent', 'Rejected'],
  Sent: ['Viewed', 'Accepted', 'Rejected', 'Expired', 'Draft'],
  Viewed: ['Accepted', 'Rejected', 'Expired'],
  Accepted: ['Converted'],
  Rejected: ['Draft'],
  Expired: ['Draft'],
  Converted: [],
};

async function getSettings() {
  const rows = await sql`SELECT * FROM company_settings WHERE id = 1`;
  if (!rows.length) throw Object.assign(new Error('Company settings have not been initialized'), { status: 500 });
  return rows[0];
}

// Atomically reserve the next quotation number under the current year.
async function reserveQuotationNumber() {
  const settings = await getSettings();
  const rows = await sql`
    UPDATE company_settings SET quotation_next_number = quotation_next_number + 1
    WHERE id = 1 RETURNING quotation_next_number - 1 AS reserved, quotation_prefix, number_digits
  `;
  const r = rows[0];
  return billing.formatDocNumber(r.quotation_prefix, new Date().getFullYear(), r.reserved, r.number_digits);
}

const DATE_FIELDS = ['quotation_date', 'valid_until'];
const TEXT_FIELDS = [
  'reference_number', 'salesperson', 'payment_terms', 'delivery_timeline',
  'contact_person', 'billing_address', 'service_address', 'mobile', 'email', 'gstin', 'pan', 'state', 'place_of_supply',
  'scope_of_work', 'deliverables', 'implementation_timeline', 'payment_schedule', 'balance_payment_terms',
  'support_period', 'warranty_amc', 'quote_validity', 'cancellation_terms', 'additional_charges', 'exclusions', 'notes',
];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function cleanHeader(body) {
  const b = body || {};
  const errors = [];
  const clientName = String(b.client_name || '').trim();
  if (!clientName) errors.push('Client/Company name is required');

  const out = { client_name: clientName };
  for (const k of TEXT_FIELDS) out[k] = b[k] != null ? String(b[k]).trim() || null : null;
  for (const k of DATE_FIELDS) {
    const v = b[k];
    if (v === undefined || v === null || v === '') { out[k] = k === 'quotation_date' ? hr.todayStr() : null; continue; }
    if (!hr.isValidDate(v)) errors.push(`${k.replace(/_/g, ' ')} is not a valid date`);
    else out[k] = v;
  }
  if (out.valid_until && out.quotation_date && out.valid_until < out.quotation_date) {
    errors.push('Valid Until cannot be before the quotation date');
  }
  if (out.email && !EMAIL_RE.test(out.email)) errors.push('Email is not valid');
  if (b.advance_payment_percent !== undefined && b.advance_payment_percent !== null && b.advance_payment_percent !== '') {
    const p = Number(b.advance_payment_percent);
    if (!Number.isFinite(p) || p < 0 || p > 100) errors.push('Advance payment % must be between 0 and 100');
    else out.advance_payment_percent = p;
  } else out.advance_payment_percent = null;

  return { out, errors };
}

async function loadFull(id) {
  const rows = await sql`SELECT * FROM quotations WHERE id = ${id}`;
  if (!rows.length) return null;
  const items = await sql`SELECT * FROM quotation_items WHERE quotation_id = ${id} ORDER BY position, id`;
  return { ...rows[0], items };
}

/* ── reads ────────────────────────────────────────────────────────────── */

router.get('/', requireManager, async (req, res) => {
  try {
    const rows = await sql`SELECT * FROM quotations ORDER BY created_at DESC, id DESC`;
    res.json(rows);
  } catch (err) {
    console.error('List quotations error:', err);
    res.status(500).json({ error: 'Failed to load quotations' });
  }
});

router.get('/:id', requireManager, async (req, res) => {
  try {
    const id = parseIntId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid quotation id' });
    const full = await loadFull(id);
    if (!full) return res.status(404).json({ error: 'Quotation not found' });
    res.json(full);
  } catch (err) {
    console.error('Get quotation error:', err);
    res.status(500).json({ error: 'Failed to load quotation' });
  }
});

/* ── create ───────────────────────────────────────────────────────────── */

router.post('/', requireManager, async (req, res) => {
  try {
    const { out, errors } = cleanHeader(req.body);
    if (errors.length) return res.status(400).json({ error: errors.join('; ') });

    const settings = await getSettings();
    const { errors: itemErrors, items, totals } = billing.computeTotals(req.body && req.body.items, settings, out.place_of_supply);
    if (itemErrors.length) return res.status(400).json({ error: itemErrors.join('; ') });

    const quotationNumber = await reserveQuotationNumber();
    const f = out;
    const rows = await sql`
      INSERT INTO quotations (
        quotation_number, quotation_date, valid_until, reference_number, salesperson, payment_terms, delivery_timeline,
        client_name, contact_person, billing_address, service_address, mobile, email, gstin, pan, state, place_of_supply,
        scope_of_work, deliverables, implementation_timeline, payment_schedule, advance_payment_percent, balance_payment_terms,
        support_period, warranty_amc, quote_validity, cancellation_terms, additional_charges, exclusions, notes,
        subtotal, discount_total, taxable_amount, cgst, sgst, igst, round_off, grand_total, status, created_by
      ) VALUES (
        ${quotationNumber}, ${f.quotation_date}, ${f.valid_until}, ${f.reference_number}, ${f.salesperson}, ${f.payment_terms}, ${f.delivery_timeline},
        ${f.client_name}, ${f.contact_person}, ${f.billing_address}, ${f.service_address}, ${f.mobile}, ${f.email}, ${f.gstin}, ${f.pan}, ${f.state}, ${f.place_of_supply},
        ${f.scope_of_work}, ${f.deliverables}, ${f.implementation_timeline}, ${f.payment_schedule}, ${f.advance_payment_percent}, ${f.balance_payment_terms},
        ${f.support_period}, ${f.warranty_amc}, ${f.quote_validity}, ${f.cancellation_terms}, ${f.additional_charges}, ${f.exclusions}, ${f.notes},
        ${totals.subtotal}, ${totals.discount_total}, ${totals.taxable_amount}, ${totals.cgst}, ${totals.sgst}, ${totals.igst}, ${totals.round_off}, ${totals.grand_total},
        'Draft', ${req.user.id}
      )
      RETURNING *
    `;
    const quotation = rows[0];

    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      await sql`
        INSERT INTO quotation_items (quotation_id, position, service_name, description, hsn_sac, quantity, unit, rate,
          discount_percent, discount_amount, tax_percent, tax_type, tax_amount, line_total)
        VALUES (${quotation.id}, ${i}, ${it.service_name}, ${it.description}, ${it.hsn_sac}, ${it.quantity}, ${it.unit}, ${it.rate},
          ${it.discount_percent}, ${it.discount_amount}, ${it.tax_percent}, ${it.tax_type}, ${it.tax_amount}, ${it.line_total})
      `;
    }

    await audit.log(req, { action: 'create', module: 'quotations', recordId: quotation.id, newValue: { quotation_number: quotationNumber, grand_total: totals.grand_total } });
    res.status(201).json(await loadFull(quotation.id));
  } catch (err) {
    console.error('Create quotation error:', err);
    const m = pgMessage(err);
    res.status(m ? 409 : (err.status || 500)).json({ error: m || err.message || 'Failed to create quotation' });
  }
});

/* ── update (Draft only) ──────────────────────────────────────────────── */

router.put('/:id', requireManager, async (req, res) => {
  try {
    const id = parseIntId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid quotation id' });
    const existing = (await sql`SELECT * FROM quotations WHERE id = ${id}`)[0];
    if (!existing) return res.status(404).json({ error: 'Quotation not found' });
    if (!EDITABLE_STATUSES.includes(existing.status)) {
      return res.status(409).json({ error: `A quotation that is already "${existing.status}" can no longer be edited` });
    }

    const { out, errors } = cleanHeader(req.body);
    if (errors.length) return res.status(400).json({ error: errors.join('; ') });

    const settings = await getSettings();
    const { errors: itemErrors, items, totals } = billing.computeTotals(req.body && req.body.items, settings, out.place_of_supply);
    if (itemErrors.length) return res.status(400).json({ error: itemErrors.join('; ') });

    const f = out;
    await sql`
      UPDATE quotations SET
        quotation_date=${f.quotation_date}, valid_until=${f.valid_until}, reference_number=${f.reference_number},
        salesperson=${f.salesperson}, payment_terms=${f.payment_terms}, delivery_timeline=${f.delivery_timeline},
        client_name=${f.client_name}, contact_person=${f.contact_person}, billing_address=${f.billing_address},
        service_address=${f.service_address}, mobile=${f.mobile}, email=${f.email}, gstin=${f.gstin}, pan=${f.pan},
        state=${f.state}, place_of_supply=${f.place_of_supply}, scope_of_work=${f.scope_of_work}, deliverables=${f.deliverables},
        implementation_timeline=${f.implementation_timeline}, payment_schedule=${f.payment_schedule},
        advance_payment_percent=${f.advance_payment_percent}, balance_payment_terms=${f.balance_payment_terms},
        support_period=${f.support_period}, warranty_amc=${f.warranty_amc}, quote_validity=${f.quote_validity},
        cancellation_terms=${f.cancellation_terms}, additional_charges=${f.additional_charges}, exclusions=${f.exclusions}, notes=${f.notes},
        subtotal=${totals.subtotal}, discount_total=${totals.discount_total}, taxable_amount=${totals.taxable_amount},
        cgst=${totals.cgst}, sgst=${totals.sgst}, igst=${totals.igst}, round_off=${totals.round_off}, grand_total=${totals.grand_total},
        updated_at = NOW()
      WHERE id = ${id}
    `;
    await sql`DELETE FROM quotation_items WHERE quotation_id = ${id}`;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      await sql`
        INSERT INTO quotation_items (quotation_id, position, service_name, description, hsn_sac, quantity, unit, rate,
          discount_percent, discount_amount, tax_percent, tax_type, tax_amount, line_total)
        VALUES (${id}, ${i}, ${it.service_name}, ${it.description}, ${it.hsn_sac}, ${it.quantity}, ${it.unit}, ${it.rate},
          ${it.discount_percent}, ${it.discount_amount}, ${it.tax_percent}, ${it.tax_type}, ${it.tax_amount}, ${it.line_total})
      `;
    }
    await audit.log(req, { action: 'update', module: 'quotations', recordId: id, newValue: { grand_total: totals.grand_total } });
    res.json(await loadFull(id));
  } catch (err) {
    console.error('Update quotation error:', err);
    res.status(500).json({ error: 'Failed to update quotation' });
  }
});

/* ── status workflow ──────────────────────────────────────────────────── */

router.put('/:id/status', requireManager, async (req, res) => {
  try {
    const id = parseIntId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid quotation id' });
    const { status } = req.body || {};
    if (!STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status' });
    if (status === 'Converted') return res.status(400).json({ error: 'Use the Convert to Invoice action, not a direct status change' });

    const existing = (await sql`SELECT * FROM quotations WHERE id = ${id}`)[0];
    if (!existing) return res.status(404).json({ error: 'Quotation not found' });
    const allowed = ALLOWED_TRANSITIONS[existing.status] || [];
    if (!allowed.includes(status) && req.user.role !== 'admin') {
      return res.status(409).json({ error: `Cannot move a "${existing.status}" quotation to "${status}"` });
    }

    const rows = await sql`UPDATE quotations SET status = ${status}, updated_at = NOW() WHERE id = ${id} RETURNING *`;
    await audit.log(req, { action: 'status', module: 'quotations', recordId: id, oldValue: { status: existing.status }, newValue: { status } });
    res.json(rows[0]);
  } catch (err) {
    console.error('Quotation status error:', err);
    res.status(500).json({ error: 'Failed to update quotation status' });
  }
});

/* ── delete (Draft only) ──────────────────────────────────────────────── */

router.delete('/:id', requireManager, async (req, res) => {
  try {
    const id = parseIntId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid quotation id' });
    const existing = (await sql`SELECT * FROM quotations WHERE id = ${id}`)[0];
    if (!existing) return res.status(404).json({ error: 'Quotation not found' });
    if (!EDITABLE_STATUSES.includes(existing.status)) {
      return res.status(409).json({ error: `A quotation that is already "${existing.status}" can no longer be deleted` });
    }
    await sql`DELETE FROM quotations WHERE id = ${id}`;
    await audit.log(req, { action: 'delete', module: 'quotations', recordId: id });
    res.json({ ok: true });
  } catch (err) {
    console.error('Delete quotation error:', err);
    res.status(500).json({ error: 'Failed to delete quotation' });
  }
});

/* ── convert to invoice ───────────────────────────────────────────────── */

async function reserveInvoiceNumber() {
  const rows = await sql`
    UPDATE company_settings SET invoice_next_number = invoice_next_number + 1
    WHERE id = 1 RETURNING invoice_next_number - 1 AS reserved, invoice_prefix, number_digits
  `;
  const r = rows[0];
  return billing.formatDocNumber(r.invoice_prefix, new Date().getFullYear(), r.reserved, r.number_digits);
}

// POST /api/quotations/:id/convert — admin or manager; only an Accepted
// quotation can become an invoice, and it can only happen once (the
// quotation's own status flip to 'Converted' makes it structurally
// impossible to convert the same quotation twice).
router.post('/:id/convert', requireManager, async (req, res) => {
  try {
    const id = parseIntId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid quotation id' });
    const q = await loadFull(id);
    if (!q) return res.status(404).json({ error: 'Quotation not found' });
    if (q.status === 'Converted') return res.status(409).json({ error: 'This quotation has already been converted to an invoice', invoiceId: q.converted_invoice_id });
    if (q.status !== 'Accepted' && req.user.role !== 'admin') {
      return res.status(409).json({ error: 'Only an Accepted quotation can be converted to an invoice' });
    }

    const invoiceNumber = await reserveInvoiceNumber();
    const today = hr.todayStr();
    // Mirror into the legacy `items` JSONB too (desc/qty/rate) so this
    // invoice displays correctly in the existing Invoice list/print path
    // without any change to that code — the rich data lives in
    // invoice_items and the new columns alongside it.
    const legacyItems = q.items.map((it) => ({ desc: it.service_name + (it.description ? ' — ' + it.description : ''), qty: Number(it.quantity), rate: Number(it.rate) }));

    const rows = await sql`
      INSERT INTO invoices (
        client, addr, gstin, date, due, terms, status, items,
        invoice_number, quotation_id, contact_person, company_name, service_address, mobile, email, pan, state, place_of_supply,
        reference_number, salesperson, subtotal, discount_total, taxable_amount, cgst, sgst, igst, round_off, grand_total, notes
      ) VALUES (
        ${q.client_name}, ${q.billing_address}, ${q.gstin}, ${today}, NULL, ${q.payment_terms}, 'Pending', ${JSON.stringify(legacyItems)}::jsonb,
        ${invoiceNumber}, ${q.id}, ${q.contact_person}, ${q.client_name}, ${q.service_address}, ${q.mobile}, ${q.email}, ${q.pan}, ${q.state}, ${q.place_of_supply},
        ${q.reference_number}, ${q.salesperson}, ${q.subtotal}, ${q.discount_total}, ${q.taxable_amount}, ${q.cgst}, ${q.sgst}, ${q.igst}, ${q.round_off}, ${q.grand_total}, ${q.notes}
      )
      RETURNING *
    `;
    const invoice = rows[0];

    for (let i = 0; i < q.items.length; i++) {
      const it = q.items[i];
      await sql`
        INSERT INTO invoice_items (invoice_id, position, service_name, description, hsn_sac, quantity, unit, rate,
          discount_percent, discount_amount, tax_percent, tax_type, tax_amount, line_total)
        VALUES (${invoice.id}, ${i}, ${it.service_name}, ${it.description}, ${it.hsn_sac}, ${it.quantity}, ${it.unit}, ${it.rate},
          ${it.discount_percent}, ${it.discount_amount}, ${it.tax_percent}, ${it.tax_type}, ${it.tax_amount}, ${it.line_total})
      `;
    }

    await sql`UPDATE quotations SET status = 'Converted', converted_invoice_id = ${invoice.id}, updated_at = NOW() WHERE id = ${id}`;
    await audit.log(req, { action: 'convert', module: 'quotations', recordId: id, newValue: { invoice_id: invoice.id, invoice_number: invoiceNumber } });
    res.status(201).json({ invoice, quotationId: id, quotationNumber: q.quotation_number });
  } catch (err) {
    console.error('Convert quotation error:', err);
    res.status(500).json({ error: 'Failed to convert quotation to invoice' });
  }
});

module.exports = router;
module.exports._test = { cleanHeader, STATUSES, ALLOWED_TRANSITIONS, EDITABLE_STATUSES };
