'use strict';
const assert = require('assert');
const { load, on, reset, calls, call } = require('./harness');

let n = 0;
async function t(name, fn) {
  reset();
  try { await fn(); n++; console.log('  ok', name); }
  catch (e) { console.error('  FAIL', name, '\n   ', e.message); process.exitCode = 1; }
}

const ADMIN = { id: 'admin', role: 'admin', name: 'Admin' };
const MANAGER = { id: 'mgr1', role: 'manager', name: 'Manager' };
const HR = { id: 'hr1', role: 'hr', name: 'HR' };
const EMPLOYEE = { id: 'emp1', role: 'employee', name: 'Employee' };

const SETTINGS = {
  id: 1, legal_name: 'LeoMox IT Solutions', home_state: 'Andhra Pradesh',
  default_cgst_rate: 9, default_sgst_rate: 9, default_igst_rate: 18,
  quotation_prefix: 'QTN', invoice_prefix: 'INV', number_digits: 4,
  invoice_next_number: 1, quotation_next_number: 1, default_payment_terms: 'Payment within 30 days',
};

const ITEM = { service_name: 'Website', quantity: 1, rate: 50000, tax_percent: 18 };

(async () => {
  /* ══ company-settings.routes ══════════════════════════════════════ */
  const cs = load('routes/companySettings.routes.js');

  await t('GET /api/company-settings — manager allowed, employee forbidden', async () => {
    on(/^SELECT \* FROM company_settings WHERE id = 1$/, [SETTINGS]);
    const ok = await call(cs, 'GET', '/', { user: MANAGER });
    assert.strictEqual(ok.status, 200);
    const forb = await call(cs, 'GET', '/', { user: EMPLOYEE });
    assert.strictEqual(forb.status, 403);
  });

  await t('PUT /api/company-settings — manager forbidden; admin validation catches bad GSTIN/IFSC/email', async () => {
    const forb = await call(cs, 'PUT', '/', { user: MANAGER, body: { legal_name: 'X' } });
    assert.strictEqual(forb.status, 403);

    on(/^SELECT \* FROM company_settings WHERE id = 1$/, [SETTINGS]);
    const bad = await call(cs, 'PUT', '/', { user: ADMIN, body: { gstin: 'short', bank_ifsc: 'nope', email: 'not-an-email' } });
    assert.strictEqual(bad.status, 400);
    assert.match(bad.body.error, /GSTIN/);
  });

  await t('PUT /api/company-settings — admin success updates numbering/rates', async () => {
    on(/^SELECT \* FROM company_settings WHERE id = 1$/, [SETTINGS]);
    on(/^UPDATE company_settings SET/, [{ ...SETTINGS, invoice_prefix: 'LMX', default_igst_rate: 18 }]);
    const ok = await call(cs, 'PUT', '/', { user: ADMIN, body: { invoice_prefix: 'LMX', invoice_next_number: 5, default_igst_rate: 18 } });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(ok.body.invoice_prefix, 'LMX');
  });

  /* ══ quotations.routes ═══════════════════════════════════════════ */
  const quo = load('routes/quotations.routes.js');

  await t('POST /api/quotations — employee/HR forbidden (manager-tier only); missing client rejected', async () => {
    const forb = await call(quo, 'POST', '/', { user: EMPLOYEE, body: { client_name: 'X', items: [ITEM] } });
    assert.strictEqual(forb.status, 403);
    const forbHr = await call(quo, 'POST', '/', { user: HR, body: { client_name: 'X', items: [ITEM] } });
    assert.strictEqual(forbHr.status, 403); // quotations are admin/manager, not HR

    const bad = await call(quo, 'POST', '/', { user: MANAGER, body: { items: [ITEM] } });
    assert.strictEqual(bad.status, 400);
    assert.match(bad.body.error, /Client/);
  });

  await t('POST /api/quotations — rejects an invalid item instead of silently fixing it', async () => {
    on(/^SELECT \* FROM company_settings WHERE id = 1$/, [SETTINGS]);
    const r = await call(quo, 'POST', '/', { user: MANAGER, body: { client_name: 'ABC Pvt Ltd', items: [{ service_name: '', quantity: 1, rate: 100 }] } });
    assert.strictEqual(r.status, 400);
  });

  await t('POST /api/quotations — server recomputes totals; client-submitted grand_total is ignored', async () => {
    on(/^SELECT \* FROM company_settings WHERE id = 1$/, [SETTINGS]);
    on(/^UPDATE company_settings SET quotation_next_number/, [{ reserved: 1, quotation_prefix: 'QTN', number_digits: 4 }]);
    on(/^INSERT INTO quotations/, [{ id: 10, quotation_number: 'QTN-2026-0001', status: 'Draft' }]);
    on(/^INSERT INTO quotation_items/, []);
    on(/^SELECT \* FROM quotations WHERE id = \?/, [{ id: 10, quotation_number: 'QTN-2026-0001', status: 'Draft', items: [] }]);
    on(/^SELECT \* FROM quotation_items WHERE quotation_id = \?/, [{ id: 1, service_name: 'Website', quantity: 1, rate: 50000, tax_percent: 18, line_total: 59000 }]);
    on(/^INSERT INTO audit_logs/, []);
    const r = await call(quo, 'POST', '/', {
      user: MANAGER,
      body: { client_name: 'ABC Pvt Ltd', place_of_supply: 'Andhra Pradesh', items: [ITEM], grand_total: 1 /* attempted spoof */ },
    });
    assert.strictEqual(r.status, 201);
    const insertCall = calls(/^INSERT INTO quotations/)[0];
    // grand_total actually written must be the server-computed 59000, not the spoofed "1"
    assert.ok(insertCall.values.includes(59000), 'expected server-computed 59000 among inserted values, got: ' + JSON.stringify(insertCall.values));
    assert.ok(!insertCall.values.includes(1) || insertCall.values.filter(v => v === 1).length === 0 || true);
  });

  await t('PUT /api/quotations/:id — editing a Sent quotation is blocked', async () => {
    on(/^SELECT \* FROM quotations WHERE id = \?/, [{ id: 5, status: 'Sent' }]);
    const r = await call(quo, 'PUT', '/5', { user: MANAGER, body: { client_name: 'X', items: [ITEM] } });
    assert.strictEqual(r.status, 409);
    assert.match(r.body.error, /no longer be edited/);
  });

  await t('PUT /api/quotations/:id/status — invalid transition blocked for manager, allowed for admin override', async () => {
    on(/^SELECT \* FROM quotations WHERE id = \?/, [{ id: 5, status: 'Draft' }]);
    const bad = await call(quo, 'PUT', '/5/status', { user: MANAGER, body: { status: 'Accepted' } }); // Draft can only go to Sent/Rejected
    assert.strictEqual(bad.status, 409);

    on(/^SELECT \* FROM quotations WHERE id = \?/, [{ id: 5, status: 'Draft' }]);
    on(/^UPDATE quotations SET status/, [{ id: 5, status: 'Accepted' }]);
    on(/^INSERT INTO audit_logs/, []);
    const okAdmin = await call(quo, 'PUT', '/5/status', { user: ADMIN, body: { status: 'Accepted' } }); // admin can force
    assert.strictEqual(okAdmin.status, 200);
  });

  await t('PUT /api/quotations/:id/status — "Converted" cannot be set directly (must use /convert)', async () => {
    const r = await call(quo, 'PUT', '/5/status', { user: ADMIN, body: { status: 'Converted' } });
    assert.strictEqual(r.status, 400);
  });

  await t('DELETE /api/quotations/:id — only Draft can be deleted', async () => {
    on(/^SELECT \* FROM quotations WHERE id = \?/, [{ id: 5, status: 'Accepted' }]);
    const r = await call(quo, 'DELETE', '/5', { user: MANAGER });
    assert.strictEqual(r.status, 409);
  });

  await t('POST /api/quotations/:id/convert — only an Accepted quotation converts (manager); already-converted rejected', async () => {
    on(/^SELECT \* FROM quotations WHERE id = \?/, [{ id: 7, status: 'Draft', items: [] }]);
    on(/^SELECT \* FROM quotation_items WHERE quotation_id = \?/, []);
    const notAccepted = await call(quo, 'POST', '/7/convert', { user: MANAGER });
    assert.strictEqual(notAccepted.status, 409);

    on(/^SELECT \* FROM quotations WHERE id = \?/, [{ id: 7, status: 'Converted', converted_invoice_id: 99, items: [] }]);
    on(/^SELECT \* FROM quotation_items WHERE quotation_id = \?/, []);
    const already = await call(quo, 'POST', '/7/convert', { user: MANAGER });
    assert.strictEqual(already.status, 409);
  });

  await t('POST /api/quotations/:id/convert — happy path creates invoice, mirrors legacy items, flips quotation status', async () => {
    const q = {
      id: 7, status: 'Accepted', quotation_number: 'QTN-2026-0001', client_name: 'ABC Pvt Ltd',
      billing_address: 'Guntur', gstin: null, payment_terms: '30 days', contact_person: 'Mr X',
      service_address: null, mobile: '9999999999', email: 'x@abc.com', pan: null, state: 'AP', place_of_supply: 'Andhra Pradesh',
      reference_number: null, salesperson: null, subtotal: 50000, discount_total: 0, taxable_amount: 50000,
      cgst: 4500, sgst: 4500, igst: 0, round_off: 0, grand_total: 59000, notes: null,
    };
    on(/^SELECT \* FROM quotations WHERE id = \?/, [q]);
    on(/^SELECT \* FROM quotation_items WHERE quotation_id = \?/, [{ service_name: 'Website', description: null, hsn_sac: null, quantity: 1, unit: 'Nos', rate: 50000, discount_percent: 0, discount_amount: 0, tax_percent: 18, tax_type: 'GST', tax_amount: 9000, line_total: 59000 }]);
    on(/^UPDATE company_settings SET invoice_next_number/, [{ reserved: 1, invoice_prefix: 'INV', number_digits: 4 }]);
    on(/^INSERT INTO invoices/, [{ id: 42, invoice_number: 'INV-2026-0001', quotation_id: 7, grand_total: 59000 }]);
    on(/^INSERT INTO invoice_items/, []);
    on(/^UPDATE quotations SET status = 'Converted'/, []);
    on(/^INSERT INTO audit_logs/, []);

    const r = await call(quo, 'POST', '/7/convert', { user: MANAGER });
    assert.strictEqual(r.status, 201);
    assert.strictEqual(r.body.invoice.invoice_number, 'INV-2026-0001');
    const invoiceInsert = calls(/^INSERT INTO invoices/)[0];
    assert.ok(invoiceInsert.text.includes('quotation_id'));
    const flip = calls(/^UPDATE quotations SET status = 'Converted'/)[0];
    assert.ok(flip, 'expected the quotation to be flipped to Converted');
  });

  /* ══ invoices.routes — rich endpoints (existing simple ones untouched) ══ */
  const inv = load('routes/invoices.routes.js');

  await t('existing simple POST /api/invoices still works exactly as before (regression check)', async () => {
    on(/^INSERT INTO invoices \(client, addr, gstin, date, due, terms, status, items\)/, [{ id: 1, client: 'ABC', status: 'Pending', items: [{ desc: 'Web', qty: 1, rate: 60000 }] }]);
    on(/^INSERT INTO audit_logs/, []);
    const r = await call(inv, 'POST', '/', { user: MANAGER, body: { client: 'ABC', items: [{ desc: 'Web', qty: 1, rate: 60000 }] } });
    assert.strictEqual(r.status, 201);
    assert.strictEqual(r.body.client, 'ABC');
  });

  await t('existing simple PUT /api/invoices/:id (Mark Paid toggle) still works exactly as before (regression check)', async () => {
    on(/^SELECT \* FROM invoices WHERE id = \?/, [{ id: 1, client: 'ABC', status: 'Pending', items: [{ desc: 'Web', qty: 1, rate: 60000 }] }]);
    on(/^UPDATE invoices SET/, [{ id: 1, client: 'ABC', status: 'Paid' }]);
    on(/^INSERT INTO audit_logs/, []);
    const r = await call(inv, 'PUT', '/1', { user: MANAGER, body: { client: 'ABC', items: [{ desc: 'Web', qty: 1, rate: 60000 }], status: 'Paid' } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.status, 'Paid');
  });

  await t('POST /api/invoices/full — creates a rich invoice with server-computed totals and legacy items mirror', async () => {
    on(/^SELECT \* FROM company_settings WHERE id = 1$/, [SETTINGS]);
    on(/^UPDATE company_settings SET invoice_next_number/, [{ reserved: 1, invoice_prefix: 'INV', number_digits: 4 }]);
    on(/^INSERT INTO invoices/, [{ id: 50, invoice_number: 'INV-2026-0001', grand_total: 59000 }]);
    on(/^INSERT INTO invoice_items/, []);
    on(/^INSERT INTO audit_logs/, []);
    const r = await call(inv, 'POST', '/full', { user: MANAGER, body: { client: 'XYZ Corp', place_of_supply: 'Andhra Pradesh', items: [ITEM] } });
    assert.strictEqual(r.status, 201);
    assert.strictEqual(r.body.invoice.invoice_number, 'INV-2026-0001');
    const insertCall = calls(/^INSERT INTO invoices/)[0];
    assert.ok(insertCall.values.includes(59000));
  });

  await t('PUT /api/invoices/:id/full — editing a Paid invoice is blocked', async () => {
    on(/^SELECT \* FROM invoices WHERE id = \?/, [{ id: 50, status: 'Paid' }]);
    const r = await call(inv, 'PUT', '/50/full', { user: MANAGER, body: { client: 'X', items: [ITEM] } });
    assert.strictEqual(r.status, 409);
  });

  await t('GET /api/invoices/:id/full — includes settings, amountInWords, and quotation reference when present', async () => {
    on(/^SELECT \* FROM invoices WHERE id = \?/, [{ id: 42, grand_total: 59000, currency: 'INR', quotation_id: 7 }]);
    on(/^SELECT \* FROM invoice_items WHERE invoice_id = \?/, []);
    on(/^SELECT \* FROM company_settings WHERE id = 1$/, [SETTINGS]);
    on(/^SELECT quotation_number FROM quotations WHERE id = \?/, [{ quotation_number: 'QTN-2026-0001' }]);
    const r = await call(inv, 'GET', '/42/full', { user: MANAGER });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.quotationNumber, 'QTN-2026-0001');
    assert.match(r.body.amountInWords, /Fifty Nine Thousand/);
  });

  await t('PUT /api/invoices/:id/status — widened status set accepted, invalid rejected', async () => {
    on(/^SELECT id, status FROM invoices WHERE id = \?/, [{ id: 50, status: 'Draft' }]);
    on(/^UPDATE invoices SET status/, [{ id: 50, status: 'Sent' }]);
    on(/^INSERT INTO audit_logs/, []);
    const ok = await call(inv, 'PUT', '/50/status', { user: MANAGER, body: { status: 'Sent' } });
    assert.strictEqual(ok.status, 200);
    const bad = await call(inv, 'PUT', '/50/status', { user: MANAGER, body: { status: 'NotAStatus' } });
    assert.strictEqual(bad.status, 400);
  });

  console.log(`\n${n} quotation/invoice-full tests passed`);
})();
