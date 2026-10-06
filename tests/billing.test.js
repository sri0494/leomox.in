'use strict';
const assert = require('assert');
const b = require('../utils/billing');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ok', name); };

const SETTINGS = { home_state: 'Andhra Pradesh', default_cgst_rate: 9, default_sgst_rate: 9, default_igst_rate: 18 };

t('defaultTaxType: same state => GST, different state => IGST, missing => GST', () => {
  assert.strictEqual(b.defaultTaxType('Andhra Pradesh', 'Andhra Pradesh'), 'GST');
  assert.strictEqual(b.defaultTaxType(' andhra pradesh ', 'Andhra Pradesh'), 'GST'); // trims/case-insensitive
  assert.strictEqual(b.defaultTaxType('Telangana', 'Andhra Pradesh'), 'IGST');
  assert.strictEqual(b.defaultTaxType(null, 'Andhra Pradesh'), 'GST');
});

t('computeLineItem: basic intra-state GST split, 18% => 9+9', () => {
  const { errors, item } = b.computeLineItem({ service_name: 'Website', quantity: 2, rate: 10000, tax_percent: 18 }, SETTINGS, 'GST');
  assert.deepStrictEqual(errors, []);
  assert.strictEqual(item.quantity * item.rate, 20000);
  assert.strictEqual(item.discount_amount, 0);
  assert.strictEqual(item.tax_amount, 3600);
  assert.strictEqual(item.cgst_amount, 1800);
  assert.strictEqual(item.sgst_amount, 1800);
  assert.strictEqual(item.igst_amount, 0);
  assert.strictEqual(item.line_total, 23600);
});

t('computeLineItem: inter-state uses IGST only, no CGST/SGST split', () => {
  const { item } = b.computeLineItem({ service_name: 'Website', quantity: 1, rate: 10000, tax_percent: 18 }, SETTINGS, 'IGST');
  assert.strictEqual(item.tax_type, 'IGST');
  assert.strictEqual(item.igst_amount, 1800);
  assert.strictEqual(item.cgst_amount, 0);
  assert.strictEqual(item.sgst_amount, 0);
});

t('computeLineItem: discount % drives discount_amount and taxable base', () => {
  const { item } = b.computeLineItem({ service_name: 'AMC', quantity: 1, rate: 10000, discount_percent: 10, tax_percent: 18 }, SETTINGS, 'GST');
  assert.strictEqual(item.discount_amount, 1000);
  assert.strictEqual(item.tax_amount, 1620);        // 9000 * 18%
  assert.strictEqual(item.line_total, 10620);
});

t('computeLineItem: flat discount_amount (no percent given) derives a display percent', () => {
  const { item } = b.computeLineItem({ service_name: 'AMC', quantity: 1, rate: 10000, discount_amount: 2500, tax_percent: 18 }, SETTINGS, 'GST');
  assert.strictEqual(item.discount_amount, 2500);
  assert.strictEqual(item.discount_percent, 25);
  assert.strictEqual(item.tax_amount, 1350);         // 7500 * 18%
});

t('computeLineItem: Exempt/None force zero tax regardless of tax_percent input', () => {
  const ex = b.computeLineItem({ service_name: 'Training', quantity: 1, rate: 5000, tax_type: 'Exempt', tax_percent: 18 }, SETTINGS, 'GST');
  assert.strictEqual(ex.item.tax_amount, 0);
  assert.strictEqual(ex.item.line_total, 5000);
  const none = b.computeLineItem({ service_name: 'Training', quantity: 1, rate: 5000, tax_type: 'None' }, SETTINGS, 'GST');
  assert.strictEqual(none.item.tax_amount, 0);
});

t('computeLineItem: missing tax_percent falls back to settings default for the resolved tax_type', () => {
  const gst = b.computeLineItem({ service_name: 'X', quantity: 1, rate: 1000 }, SETTINGS, 'GST');
  assert.strictEqual(gst.item.tax_percent, 18); // 9 + 9 from settings
  const igst = b.computeLineItem({ service_name: 'X', quantity: 1, rate: 1000 }, SETTINGS, 'IGST');
  assert.strictEqual(igst.item.tax_percent, 18);
});

t('computeLineItem: validation — missing name, bad qty/rate/discount/tax are all reported, not thrown', () => {
  assert.ok(b.computeLineItem({ quantity: 1, rate: 100 }, SETTINGS, 'GST').errors.some(e => /name/.test(e)));
  assert.ok(b.computeLineItem({ service_name: 'X', quantity: 0, rate: 100 }, SETTINGS, 'GST').errors.some(e => /quantity/.test(e)));
  assert.ok(b.computeLineItem({ service_name: 'X', quantity: 1, rate: -5 }, SETTINGS, 'GST').errors.some(e => /rate/.test(e)));
  assert.ok(b.computeLineItem({ service_name: 'X', quantity: 1, rate: 100, discount_percent: 150 }, SETTINGS, 'GST').errors.some(e => /discount/.test(e)));
  assert.ok(b.computeLineItem({ service_name: 'X', quantity: 1, rate: 100, discount_amount: 999 }, SETTINGS, 'GST').errors.some(e => /discount amount/.test(e)));
  assert.ok(b.computeLineItem({ service_name: 'X', quantity: 1, rate: 100, tax_percent: 500 }, SETTINGS, 'GST').errors.some(e => /tax/.test(e)));
});

t('computeTotals: multi-item intra-state invoice sums correctly and rounds the grand total', () => {
  const { errors, items, totals } = b.computeTotals([
    { service_name: 'Website', quantity: 1, rate: 50000, tax_percent: 18 },
    { service_name: 'Hosting', quantity: 12, rate: 833.33, tax_percent: 18 },
  ], SETTINGS, 'Andhra Pradesh');
  assert.deepStrictEqual(errors, []);
  assert.strictEqual(items.length, 2);
  assert.strictEqual(totals.tax_type, 'GST');
  assert.strictEqual(totals.subtotal, 50000 + 12 * 833.33);
  assert.strictEqual(Number.isInteger(totals.grand_total), true); // rounded to the nearest rupee
  // round_off should exactly reconcile taxable+tax to the rounded grand total
  const exact = totals.taxable_amount + totals.cgst + totals.sgst + totals.igst;
  assert.strictEqual(Math.round((exact + totals.round_off) * 100) / 100, totals.grand_total);
});

t('computeTotals: inter-state invoice has igst only, cgst/sgst zero', () => {
  const { totals } = b.computeTotals([{ service_name: 'Website', quantity: 1, rate: 10000, tax_percent: 18 }], SETTINGS, 'Telangana');
  assert.strictEqual(totals.tax_type, 'IGST');
  assert.strictEqual(totals.cgst, 0);
  assert.strictEqual(totals.sgst, 0);
  assert.strictEqual(totals.igst, 1800);
});

t('computeTotals: rejects empty/missing items without throwing', () => {
  assert.ok(b.computeTotals([], SETTINGS, 'Andhra Pradesh').errors.length);
  assert.ok(b.computeTotals(null, SETTINGS, 'Andhra Pradesh').errors.length);
  assert.ok(b.computeTotals(new Array(201).fill({ service_name: 'X', quantity: 1, rate: 1 }), SETTINGS, 'Andhra Pradesh').errors.length);
});

t('computeTotals: one bad item blocks the whole document (no partial save)', () => {
  const { errors, totals } = b.computeTotals([
    { service_name: 'Good', quantity: 1, rate: 100, tax_percent: 18 },
    { service_name: '', quantity: 1, rate: 100 }, // missing name
  ], SETTINGS, 'Andhra Pradesh');
  assert.ok(errors.length);
  assert.strictEqual(totals, null);
});

t('numberToWords / amountInWords match the existing client-side Indian-numbering format', () => {
  assert.strictEqual(b.numberToWords(0), 'Zero');
  assert.strictEqual(b.numberToWords(23600), 'Twenty Three Thousand Six Hundred');
  assert.strictEqual(b.numberToWords(100000), 'One Lakh');
  assert.strictEqual(b.numberToWords(10000000), 'One Crore');
  assert.strictEqual(b.amountInWords(23600), 'Rupees Twenty Three Thousand Six Hundred Only');
});

t('formatDocNumber: zero-padded sequence with configurable width', () => {
  assert.strictEqual(b.formatDocNumber('INV', 2026, 1, 4), 'INV-2026-0001');
  assert.strictEqual(b.formatDocNumber('QTN', 2026, 42, 4), 'QTN-2026-0042');
  assert.strictEqual(b.formatDocNumber('INV', 2026, 1, 6), 'INV-2026-000001');
});

console.log(`\n${n} billing tests passed`);
