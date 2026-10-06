'use strict';
/**
 * Pure helpers for the Quotation/Invoice billing engine — no database, no
 * Express. Every number the client submits for an item (qty, rate, discount,
 * tax %) is treated as an *input*; every amount (discount_amount, tax_amount,
 * line_total, and every document-level total) is *recomputed* here and is
 * what actually gets stored — the frontend's own arithmetic is never trusted
 * (per the spec's "never trust totals submitted by the frontend" rule).
 */

const TAX_TYPES = ['GST', 'IGST', 'Exempt', 'None'];
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * Decide GST vs IGST for a document when the caller didn't pin a tax_type
 * on every line: intra-state (buyer's state matches the company's home
 * state) is CGST+SGST ("GST" here), anything else is inter-state IGST.
 */
function defaultTaxType(placeOfSupply, homeState) {
  if (!placeOfSupply || !homeState) return 'GST';
  return String(placeOfSupply).trim().toLowerCase() === String(homeState).trim().toLowerCase() ? 'GST' : 'IGST';
}

/**
 * Compute one line item. `raw` is whatever the client sent for that row;
 * `settings` supplies the default CGST/SGST/IGST rates when a line doesn't
 * specify its own tax_percent; `autoTaxType` is this document's GST-vs-IGST
 * default (from defaultTaxType), used when the line doesn't specify tax_type.
 */
function computeLineItem(raw, settings, autoTaxType) {
  const errors = [];
  const r = raw || {};
  const serviceName = String(r.service_name || r.desc || '').trim();
  if (!serviceName) errors.push('Each item needs a Service/Product name');

  const quantity = Number(r.quantity != null ? r.quantity : r.qty);
  const rate = Number(r.rate);
  if (!Number.isFinite(quantity) || quantity <= 0) errors.push(`"${serviceName || 'item'}": quantity must be a positive number`);
  if (!Number.isFinite(rate) || rate < 0) errors.push(`"${serviceName || 'item'}": rate must be a non-negative number`);
  const safeQty = Number.isFinite(quantity) && quantity > 0 ? quantity : 0;
  const safeRate = Number.isFinite(rate) && rate >= 0 ? rate : 0;
  const gross = round2(safeQty * safeRate);

  let discountPercent = Number(r.discount_percent) || 0;
  if (discountPercent < 0 || discountPercent > 100) { errors.push(`"${serviceName || 'item'}": discount % must be between 0 and 100`); discountPercent = Math.min(Math.max(discountPercent, 0), 100); }
  let discountAmount;
  if (discountPercent > 0) {
    discountAmount = round2(gross * discountPercent / 100);
  } else {
    discountAmount = round2(Number(r.discount_amount) || 0);
    if (discountAmount > gross) { errors.push(`"${serviceName || 'item'}": discount amount cannot exceed the line amount`); discountAmount = gross; }
    // keep discount_percent in sync for display, derived from the flat amount
    discountPercent = gross > 0 ? round2((discountAmount / gross) * 100) : 0;
  }

  const taxable = round2(gross - discountAmount);

  let taxType = TAX_TYPES.includes(r.tax_type) ? r.tax_type : (autoTaxType || 'GST');
  let taxPercent = Number(r.tax_percent);
  if (!Number.isFinite(taxPercent) || taxPercent < 0) {
    taxPercent = taxType === 'IGST' ? Number(settings.default_igst_rate) || 18
      : taxType === 'GST' ? (Number(settings.default_cgst_rate) || 9) + (Number(settings.default_sgst_rate) || 9)
      : 0;
  }
  if (taxPercent > 100) { errors.push(`"${serviceName || 'item'}": tax % looks too high`); taxPercent = 100; }
  if (taxType === 'Exempt' || taxType === 'None') taxPercent = 0;

  const taxAmount = round2(taxable * taxPercent / 100);
  const cgstAmount = taxType === 'GST' ? round2(taxAmount / 2) : 0;
  const sgstAmount = taxType === 'GST' ? round2(taxAmount - cgstAmount) : 0; // remainder, so the two halves always sum exactly to taxAmount
  const igstAmount = taxType === 'IGST' ? taxAmount : 0;
  const lineTotal = round2(taxable + taxAmount);

  return {
    errors,
    item: {
      service_name: serviceName, description: String(r.description || '').trim() || null,
      hsn_sac: String(r.hsn_sac || '').trim() || null,
      quantity: safeQty, unit: String(r.unit || 'Nos').trim() || 'Nos', rate: safeRate,
      discount_percent: discountPercent, discount_amount: discountAmount,
      tax_percent: taxPercent, tax_type: taxType, tax_amount: taxAmount,
      cgst_amount: cgstAmount, sgst_amount: sgstAmount, igst_amount: igstAmount,
      line_total: lineTotal,
    },
  };
}

/**
 * Compute every line item plus document-level totals (subtotal, discount,
 * taxable amount, CGST/SGST/IGST, round-off, grand total). Returns
 * { errors, items, totals } — `errors` is non-empty whenever any input was
 * invalid, in which case the caller should reject the request rather than
 * save anything.
 */
function computeTotals(rawItems, settings, placeOfSupply) {
  const errors = [];
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    return { errors: ['At least one line item is required'], items: [], totals: null };
  }
  if (rawItems.length > 200) {
    return { errors: ['Too many line items (max 200)'], items: [], totals: null };
  }
  const autoTaxType = defaultTaxType(placeOfSupply, settings && settings.home_state);
  const items = [];
  for (const raw of rawItems) {
    const { errors: itemErrors, item } = computeLineItem(raw, settings || {}, autoTaxType);
    errors.push(...itemErrors);
    items.push(item);
  }
  if (errors.length) return { errors, items, totals: null };

  const sum = (key) => round2(items.reduce((s, it) => s + it[key], 0));
  const grossTotal = round2(items.reduce((s, it) => s + it.quantity * it.rate, 0));
  const discountTotal = sum('discount_amount');
  const taxableAmount = round2(grossTotal - discountTotal);
  const cgst = sum('cgst_amount');
  const sgst = sum('sgst_amount');
  const igst = sum('igst_amount');
  const exactGrandTotal = round2(taxableAmount + cgst + sgst + igst);
  const roundedGrandTotal = Math.round(exactGrandTotal);
  const roundOff = round2(roundedGrandTotal - exactGrandTotal);

  return {
    errors: [],
    items,
    totals: {
      subtotal: grossTotal, discount_total: discountTotal, taxable_amount: taxableAmount,
      cgst, sgst, igst, round_off: roundOff, grand_total: roundedGrandTotal,
      tax_type: autoTaxType,
    },
  };
}

/* ── Amount in words (Indian numbering: Lakh/Crore), mirrors the ───────────
   client-side numberToWords() used elsewhere in the app, so a figure reads
   identically whether it was written by the server or the browser. ──────── */
const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
  'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function numberToWords(n) {
  n = Math.abs(Math.round(Number(n) || 0));
  if (n === 0) return 'Zero';
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? ' ' + ONES[n % 10] : '');
  if (n < 1000) return ONES[Math.floor(n / 100)] + ' Hundred' + (n % 100 ? ' ' + numberToWords(n % 100) : '');
  if (n < 100000) return numberToWords(Math.floor(n / 1000)) + ' Thousand' + (n % 1000 ? ' ' + numberToWords(n % 1000) : '');
  if (n < 10000000) return numberToWords(Math.floor(n / 100000)) + ' Lakh' + (n % 100000 ? ' ' + numberToWords(n % 100000) : '');
  return numberToWords(Math.floor(n / 10000000)) + ' Crore' + (n % 10000000 ? ' ' + numberToWords(n % 10000000) : '');
}
function amountInWords(n, currency) {
  const cur = currency || 'INR';
  const label = cur === 'INR' ? 'Rupees' : cur;
  return label + ' ' + numberToWords(n) + ' Only';
}

/* ── Document number formatting ──────────────────────────────────────────
   The actual atomic "reserve the next number" increment has to happen in
   SQL (UPDATE ... RETURNING, so two concurrent requests can never get the
   same number) — that lives in the route handlers, right next to the `sql`
   client. This just turns a reserved sequence number into the printed
   string, so the format is defined in exactly one place. */
function formatDocNumber(prefix, year, seq, digits) {
  const d = Math.max(Number(digits) || 4, 1);
  return `${prefix}-${year}-${String(seq).padStart(d, '0')}`;
}

module.exports = {
  TAX_TYPES, round2, defaultTaxType, computeLineItem, computeTotals,
  numberToWords, amountInWords, formatDocNumber,
};
