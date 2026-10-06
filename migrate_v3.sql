-- ═══════════════════════════════════════════════════════════════
--  LeoMox HRMS — Migration v3 (Invoice & Quotation business module)
--  Run AFTER schema.sql, migrate.sql and migrate_v2.sql. Safe to re-run.
--
--  Everything here is ADDITIVE: no existing column is renamed, retyped
--  (except one widening, noted below) or dropped, and the existing
--  `invoices.items` JSONB column, its CHECK constraint, and every
--  existing invoice row keep working exactly as before. New invoices
--  created through the existing simple form are unaffected; the new
--  rich fields are only populated by the new Quotation/rich-Invoice
--  flow and are NULL/zero on everything else.
-- ═══════════════════════════════════════════════════════════════

-- ── Company Settings (singleton — one row, id = 1) ─────────────
-- Centralizes the business/bank/numbering details so invoices and
-- quotations never hard-code them (rule #15 of the spec).
CREATE TABLE IF NOT EXISTS company_settings (
  id                      INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1), -- enforces a single row
  legal_name              TEXT NOT NULL DEFAULT 'LeoMox IT Solutions',
  registered_address      TEXT,
  office_address          TEXT,
  gstin                   TEXT,
  pan                     TEXT,
  cin                     TEXT,
  email                   TEXT,
  phone                   TEXT,
  website                 TEXT,
  logo_url                TEXT,

  bank_holder_name        TEXT,
  bank_name               TEXT,
  bank_account_no         TEXT,
  bank_ifsc               TEXT,
  bank_branch             TEXT,
  bank_account_type       TEXT,
  upi_id                  TEXT,

  invoice_prefix          TEXT NOT NULL DEFAULT 'INV',
  quotation_prefix        TEXT NOT NULL DEFAULT 'QTN',
  invoice_next_number     INTEGER NOT NULL DEFAULT 1,
  quotation_next_number   INTEGER NOT NULL DEFAULT 1,
  number_digits           INTEGER NOT NULL DEFAULT 4,  -- zero-pad width, e.g. 0001

  home_state              TEXT NOT NULL DEFAULT 'Andhra Pradesh', -- place_of_supply == this => CGST+SGST, else IGST
  default_cgst_rate       NUMERIC(5,2) NOT NULL DEFAULT 9,
  default_sgst_rate       NUMERIC(5,2) NOT NULL DEFAULT 9,
  default_igst_rate       NUMERIC(5,2) NOT NULL DEFAULT 18,

  default_payment_terms   TEXT DEFAULT 'Payment within 30 days',
  default_terms           TEXT,   -- general service terms & conditions
  late_payment_terms      TEXT,
  cancellation_terms      TEXT,
  jurisdiction            TEXT,

  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by              TEXT REFERENCES users(id) ON DELETE SET NULL
);
INSERT INTO company_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- ── Quotations ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS quotations (
  id                       SERIAL PRIMARY KEY,
  quotation_number         TEXT UNIQUE NOT NULL,
  quotation_date           DATE NOT NULL DEFAULT CURRENT_DATE,
  valid_until              DATE,
  reference_number         TEXT,
  salesperson              TEXT,
  payment_terms            TEXT,
  delivery_timeline        TEXT,

  client_name              TEXT NOT NULL,
  contact_person           TEXT,
  billing_address          TEXT,
  service_address          TEXT,
  mobile                   TEXT,
  email                    TEXT,
  gstin                    TEXT,
  pan                      TEXT,
  state                    TEXT,
  place_of_supply          TEXT,

  scope_of_work            TEXT,
  deliverables             TEXT,
  implementation_timeline  TEXT,
  payment_schedule         TEXT,
  advance_payment_percent  NUMERIC(5,2),
  balance_payment_terms    TEXT,
  support_period           TEXT,
  warranty_amc             TEXT,
  quote_validity           TEXT,
  cancellation_terms       TEXT,
  additional_charges       TEXT,
  exclusions               TEXT,
  notes                    TEXT,

  -- Authoritative totals — always recomputed server-side from the line
  -- items on every create/update; the frontend's numbers are never trusted.
  subtotal                 NUMERIC(12,2) NOT NULL DEFAULT 0,
  discount_total           NUMERIC(12,2) NOT NULL DEFAULT 0,
  taxable_amount           NUMERIC(12,2) NOT NULL DEFAULT 0,
  cgst                     NUMERIC(12,2) NOT NULL DEFAULT 0,
  sgst                     NUMERIC(12,2) NOT NULL DEFAULT 0,
  igst                     NUMERIC(12,2) NOT NULL DEFAULT 0,
  round_off                NUMERIC(6,2)  NOT NULL DEFAULT 0,
  grand_total               NUMERIC(12,2) NOT NULL DEFAULT 0,

  status                   TEXT NOT NULL DEFAULT 'Draft'
                            CHECK (status IN ('Draft','Sent','Viewed','Accepted','Rejected','Expired','Converted')),
  converted_invoice_id     INTEGER,  -- FK added below, after invoices gets its own id (already does) — see ALTER
  created_by               TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS quotation_items (
  id                 SERIAL PRIMARY KEY,
  quotation_id       INTEGER NOT NULL REFERENCES quotations(id) ON DELETE CASCADE,
  position           INTEGER NOT NULL DEFAULT 0,
  service_name       TEXT NOT NULL,
  description        TEXT,
  hsn_sac            TEXT,
  quantity           NUMERIC(10,2) NOT NULL DEFAULT 1,
  unit               TEXT NOT NULL DEFAULT 'Nos',
  rate               NUMERIC(12,2) NOT NULL DEFAULT 0,
  discount_percent   NUMERIC(5,2)  NOT NULL DEFAULT 0,
  discount_amount    NUMERIC(12,2) NOT NULL DEFAULT 0,
  tax_percent        NUMERIC(5,2)  NOT NULL DEFAULT 18,
  tax_type           TEXT NOT NULL DEFAULT 'GST' CHECK (tax_type IN ('GST','IGST','Exempt','None')),
  tax_amount         NUMERIC(12,2) NOT NULL DEFAULT 0,
  line_total         NUMERIC(12,2) NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_quotation_items_qid ON quotation_items(quotation_id);

-- ── Invoices: additive extension for the rich business workflow ──
-- Every column below is nullable with a safe default, so every existing
-- row (and every insert from the original simple invoice form, which
-- never sets these) is completely unaffected.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS invoice_number        TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS quotation_id          INTEGER REFERENCES quotations(id) ON DELETE SET NULL;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS contact_person        TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS company_name          TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS service_address       TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS mobile                TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS email                 TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS pan                   TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS state                 TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS place_of_supply       TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS po_number             TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS po_date               DATE;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS reference_number      TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS salesperson           TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS currency              TEXT NOT NULL DEFAULT 'INR';
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS subtotal              NUMERIC(12,2);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS discount_total        NUMERIC(12,2);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS taxable_amount        NUMERIC(12,2);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS cgst                  NUMERIC(12,2);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS sgst                  NUMERIC(12,2);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS igst                  NUMERIC(12,2);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS round_off             NUMERIC(6,2);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS grand_total           NUMERIC(12,2);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS notes                 TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE UNIQUE INDEX IF NOT EXISTS uq_invoices_invoice_number ON invoices(invoice_number) WHERE invoice_number IS NOT NULL;

-- Now that invoices exists with its own id (it always did), wire the
-- quotation -> invoice back-reference's FK.
ALTER TABLE quotations DROP CONSTRAINT IF EXISTS quotations_converted_invoice_id_fkey;
ALTER TABLE quotations ADD CONSTRAINT quotations_converted_invoice_id_fkey
  FOREIGN KEY (converted_invoice_id) REFERENCES invoices(id) ON DELETE SET NULL;

-- Widen the status list for the new workflow (rule #12) while keeping every
-- value the app already uses. Existing rows/values are untouched.
ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_status_check;
ALTER TABLE invoices ADD CONSTRAINT invoices_status_check
  CHECK (status IN ('Pending','Paid','Overdue','Cancelled','Draft','Sent','Viewed','Partially Paid'));

CREATE TABLE IF NOT EXISTS invoice_items (
  id                 SERIAL PRIMARY KEY,
  invoice_id         INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  position           INTEGER NOT NULL DEFAULT 0,
  service_name       TEXT NOT NULL,
  description        TEXT,
  hsn_sac            TEXT,
  quantity           NUMERIC(10,2) NOT NULL DEFAULT 1,
  unit               TEXT NOT NULL DEFAULT 'Nos',
  rate               NUMERIC(12,2) NOT NULL DEFAULT 0,
  discount_percent   NUMERIC(5,2)  NOT NULL DEFAULT 0,
  discount_amount    NUMERIC(12,2) NOT NULL DEFAULT 0,
  tax_percent        NUMERIC(5,2)  NOT NULL DEFAULT 18,
  tax_type           TEXT NOT NULL DEFAULT 'GST' CHECK (tax_type IN ('GST','IGST','Exempt','None')),
  tax_amount         NUMERIC(12,2) NOT NULL DEFAULT 0,
  line_total         NUMERIC(12,2) NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_invoice_items_iid ON invoice_items(invoice_id);

-- Every existing (and future-simple) invoice keeps using the legacy
-- `items` JSONB column exactly as before — `invoice_items` rows only exist
-- for invoices created via the new rich form or a quotation conversion.
-- The presence of `invoice_number`/`grand_total` (NOT NULL in the app logic,
-- though nullable in the DB for backward compatibility) is what the API
-- uses to tell a "rich" invoice from a legacy one; it is never inferred
-- from whether invoice_items happens to have rows.
