'use strict';
const express = require('express');
const { sql } = require('../db');
const { requireManager, requireAdmin } = require('../middleware/auth');
const audit = require('../utils/audit');

const router = express.Router();

const TEXT_FIELDS = [
  'legal_name', 'registered_address', 'office_address', 'gstin', 'pan', 'cin', 'email', 'phone', 'website', 'logo_url',
  'bank_holder_name', 'bank_name', 'bank_account_no', 'bank_ifsc', 'bank_branch', 'bank_account_type', 'upi_id',
  'invoice_prefix', 'quotation_prefix', 'home_state',
  'default_payment_terms', 'default_terms', 'late_payment_terms', 'cancellation_terms', 'jurisdiction',
];
const NUMBER_FIELDS = {
  invoice_next_number: { min: 1, max: 999999, int: true },
  quotation_next_number: { min: 1, max: 999999, int: true },
  number_digits: { min: 1, max: 10, int: true },
  default_cgst_rate: { min: 0, max: 100 },
  default_sgst_rate: { min: 0, max: 100 },
  default_igst_rate: { min: 0, max: 100 },
};

async function loadSettings() {
  const rows = await sql`SELECT * FROM company_settings WHERE id = 1`;
  return rows[0] || null;
}

// GET /api/company-settings — any staff role that touches invoices/quotations
// needs this to render documents (bank details, GSTIN, numbering), but it's
// not public: bank account numbers have no business being internet-exposed.
router.get('/', requireManager, async (req, res) => {
  try {
    const settings = await loadSettings();
    if (!settings) return res.status(500).json({ error: 'Company settings have not been initialized' });
    res.json(settings);
  } catch (err) {
    console.error('Get company settings error:', err);
    res.status(500).json({ error: 'Failed to load company settings' });
  }
});

// PUT /api/company-settings — admin only
router.put('/', requireAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    const existing = await loadSettings();
    if (!existing) return res.status(500).json({ error: 'Company settings have not been initialized' });

    const errors = [];
    const patch = {};
    for (const k of TEXT_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(b, k)) continue;
      const v = b[k] === null || b[k] === undefined ? null : String(b[k]).trim();
      patch[k] = v === '' ? null : v;
    }
    if (patch.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(patch.email)) errors.push('Email is not valid');
    if (patch.gstin && !/^[0-9A-Z]{15}$/i.test(patch.gstin)) errors.push('GSTIN must be 15 characters');
    if (patch.pan && !/^[A-Z]{5}[0-9]{4}[A-Z]$/i.test(patch.pan)) errors.push('PAN must look like ABCDE1234F');
    if (patch.bank_ifsc && !/^[A-Z]{4}0[A-Z0-9]{6}$/i.test(patch.bank_ifsc)) errors.push('IFSC must look like SBIN0001234');
    if (!patch.legal_name && Object.prototype.hasOwnProperty.call(b, 'legal_name')) errors.push('Legal/Business name is required');

    for (const [k, rule] of Object.entries(NUMBER_FIELDS)) {
      if (!Object.prototype.hasOwnProperty.call(b, k)) continue;
      const n = Number(b[k]);
      if (!Number.isFinite(n) || n < rule.min || n > rule.max || (rule.int && !Number.isInteger(n))) {
        errors.push(`${k.replace(/_/g, ' ')} must be a number between ${rule.min} and ${rule.max}`);
      } else {
        patch[k] = n;
      }
    }
    if (errors.length) return res.status(400).json({ error: errors.join('; ') });

    const f = { ...existing, ...patch };
    const rows = await sql`
      UPDATE company_settings SET
        legal_name = ${f.legal_name}, registered_address = ${f.registered_address}, office_address = ${f.office_address},
        gstin = ${f.gstin}, pan = ${f.pan}, cin = ${f.cin}, email = ${f.email}, phone = ${f.phone},
        website = ${f.website}, logo_url = ${f.logo_url},
        bank_holder_name = ${f.bank_holder_name}, bank_name = ${f.bank_name}, bank_account_no = ${f.bank_account_no},
        bank_ifsc = ${f.bank_ifsc}, bank_branch = ${f.bank_branch}, bank_account_type = ${f.bank_account_type}, upi_id = ${f.upi_id},
        invoice_prefix = ${f.invoice_prefix}, quotation_prefix = ${f.quotation_prefix},
        invoice_next_number = ${f.invoice_next_number}, quotation_next_number = ${f.quotation_next_number}, number_digits = ${f.number_digits},
        home_state = ${f.home_state}, default_cgst_rate = ${f.default_cgst_rate}, default_sgst_rate = ${f.default_sgst_rate}, default_igst_rate = ${f.default_igst_rate},
        default_payment_terms = ${f.default_payment_terms}, default_terms = ${f.default_terms},
        late_payment_terms = ${f.late_payment_terms}, cancellation_terms = ${f.cancellation_terms}, jurisdiction = ${f.jurisdiction},
        updated_at = NOW(), updated_by = ${req.user.id}
      WHERE id = 1
      RETURNING *
    `;
    await audit.log(req, { action: 'update', module: 'company_settings', recordId: 1, newValue: { fields: Object.keys(patch) } });
    res.json(rows[0]);
  } catch (err) {
    console.error('Update company settings error:', err);
    res.status(500).json({ error: 'Failed to save company settings' });
  }
});

module.exports = router;
module.exports._test = { loadSettings };
