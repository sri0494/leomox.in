-- ═══════════════════════════════════════════════════════════════
--  LeoMox HRMS — Phase 1-8 Migration
--  Run in Neon SQL Editor AFTER existing schema.sql
--  Safe to run multiple times (IF NOT EXISTS / ON CONFLICT)
-- ═══════════════════════════════════════════════════════════════

-- ── Fix users role constraint to include all roles ────────────
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('admin','manager','hr','employee'));

-- ── Departments ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS departments (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  head_id    INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Designations ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS designations (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Permissions ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS permissions (
  id   TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  label    TEXT NOT NULL
);

INSERT INTO permissions (id, category, label) VALUES
  ('employee.view',       'Employee',    'View Employees'),
  ('employee.create',     'Employee',    'Create Employee'),
  ('employee.edit',       'Employee',    'Edit Employee'),
  ('employee.delete',     'Employee',    'Delete Employee'),
  ('employee.import',     'Employee',    'Bulk Import'),
  ('employee.export',     'Employee',    'Export Employees'),
  ('attendance.view',     'Attendance',  'View Attendance'),
  ('attendance.create',   'Attendance',  'Mark Attendance'),
  ('attendance.edit',     'Attendance',  'Edit Attendance'),
  ('attendance.import',   'Attendance',  'Import Attendance'),
  ('attendance.export',   'Attendance',  'Export Attendance'),
  ('salary.view',         'Salary',      'View Salary'),
  ('salary.create',       'Salary',      'Create Salary'),
  ('salary.edit',         'Salary',      'Edit Salary'),
  ('payroll.view',        'Payroll',     'View Payroll'),
  ('payroll.create',      'Payroll',     'Create Payroll'),
  ('payroll.edit',        'Payroll',     'Edit Payroll'),
  ('payroll.approve',     'Payroll',     'Approve Payroll'),
  ('payroll.lock',        'Payroll',     'Lock Payroll'),
  ('payroll.export',      'Payroll',     'Export Payroll'),
  ('leave.view',          'Leave',       'View Leave'),
  ('leave.apply',         'Leave',       'Apply Leave'),
  ('leave.approve',       'Leave',       'Approve Leave'),
  ('leave.manage_policy', 'Leave',       'Manage Leave Policy'),
  ('reports.view',        'Reports',     'View Reports'),
  ('reports.export',      'Reports',     'Export Reports'),
  ('users.view',          'Users',       'View Users'),
  ('users.create',        'Users',       'Create Users'),
  ('users.edit',          'Users',       'Edit Users'),
  ('users.delete',        'Users',       'Delete Users'),
  ('permissions.manage',  'Users',       'Manage Permissions'),
  ('audit.view',          'Audit',       'View Audit Logs')
ON CONFLICT (id) DO NOTHING;

-- ── User Permissions (per-user overrides) ────────────────────
CREATE TABLE IF NOT EXISTS user_permissions (
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission_id TEXT NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  granted       BOOLEAN NOT NULL DEFAULT TRUE,
  granted_by    TEXT REFERENCES users(id),
  granted_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, permission_id)
);

-- ── Enhanced Employees table (add columns to existing) ────────
ALTER TABLE employees ADD COLUMN IF NOT EXISTS emp_code    TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS first_name  TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS last_name   TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS gender      TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS dob         DATE;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS personal_email TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS blood_group TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS marital_status TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS confirm_date DATE;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS emp_type    TEXT DEFAULT 'Full Time';
ALTER TABLE employees ADD COLUMN IF NOT EXISTS manager_id  INTEGER REFERENCES employees(id);
ALTER TABLE employees ADD COLUMN IF NOT EXISTS location    TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS work_mode   TEXT DEFAULT 'Office';
ALTER TABLE employees ADD COLUMN IF NOT EXISTS notice_period INTEGER DEFAULT 30;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS date_leaving DATE;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS leave_reason TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS perm_address TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS curr_address TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS city        TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS state       TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS pincode     TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS emg_name    TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS emg_relation TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS emg_phone   TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS user_id     TEXT REFERENCES users(id);
ALTER TABLE employees DROP CONSTRAINT IF EXISTS employees_status_check;
ALTER TABLE employees ADD CONSTRAINT employees_status_check
  CHECK (status IN ('Active','Inactive','On Leave','Probation','On Notice','Resigned','Terminated','Relieved'));

-- ── Employee Bank Details ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS employee_bank (
  id           SERIAL PRIMARY KEY,
  employee_id  INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  holder_name  TEXT,
  bank_name    TEXT,
  branch       TEXT,
  account_no   TEXT,
  ifsc         TEXT,
  account_type TEXT,
  pay_mode     TEXT DEFAULT 'Bank Transfer',
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Employee Statutory Details ────────────────────────────────
CREATE TABLE IF NOT EXISTS employee_statutory (
  id           SERIAL PRIMARY KEY,
  employee_id  INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  pan          TEXT,
  aadhaar_ref  TEXT,
  uan          TEXT,
  pf_number    TEXT,
  esic_number  TEXT,
  pt_applicable BOOLEAN DEFAULT FALSE,
  lwf_applicable BOOLEAN DEFAULT FALSE,
  tax_regime   TEXT DEFAULT 'New',
  tds_applicable BOOLEAN DEFAULT FALSE,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Salary Components ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS salary_components (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  type       TEXT NOT NULL CHECK (type IN ('earning','deduction','employer')),
  is_fixed   BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO salary_components (name, type, is_fixed) VALUES
  ('Basic',                  'earning',   TRUE),
  ('HRA',                    'earning',   FALSE),
  ('Conveyance',             'earning',   TRUE),
  ('Medical Allowance',      'earning',   TRUE),
  ('Special Allowance',      'earning',   FALSE),
  ('Performance Incentive',  'earning',   FALSE),
  ('Overtime',               'earning',   FALSE),
  ('Bonus',                  'earning',   FALSE),
  ('Employee PF',            'deduction', FALSE),
  ('Employee ESI',           'deduction', FALSE),
  ('Professional Tax',       'deduction', TRUE),
  ('TDS',                    'deduction', FALSE),
  ('LWF',                    'deduction', TRUE),
  ('Loan Recovery',          'deduction', FALSE),
  ('Other Deductions',       'deduction', FALSE),
  ('Employer PF',            'employer',  FALSE),
  ('Employer ESI',           'employer',  FALSE),
  ('Gratuity Provision',     'employer',  FALSE)
ON CONFLICT DO NOTHING;

-- ── Employee Salary Structure ─────────────────────────────────
CREATE TABLE IF NOT EXISTS employee_salary (
  id              SERIAL PRIMARY KEY,
  employee_id     INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  effective_from  DATE NOT NULL DEFAULT CURRENT_DATE,
  basic           NUMERIC(12,2) DEFAULT 0,
  hra             NUMERIC(12,2) DEFAULT 0,
  conveyance      NUMERIC(12,2) DEFAULT 0,
  medical         NUMERIC(12,2) DEFAULT 0,
  special         NUMERIC(12,2) DEFAULT 0,
  other_earnings  NUMERIC(12,2) DEFAULT 0,
  emp_pf          NUMERIC(12,2) DEFAULT 0,
  emp_esi         NUMERIC(12,2) DEFAULT 0,
  prof_tax        NUMERIC(12,2) DEFAULT 0,
  tds             NUMERIC(12,2) DEFAULT 0,
  lwf             NUMERIC(12,2) DEFAULT 0,
  other_deductions NUMERIC(12,2) DEFAULT 0,
  er_pf           NUMERIC(12,2) DEFAULT 0,
  er_esi          NUMERIC(12,2) DEFAULT 0,
  gratuity        NUMERIC(12,2) DEFAULT 0,
  gross           NUMERIC(12,2) GENERATED ALWAYS AS (basic+hra+conveyance+medical+special+other_earnings) STORED,
  total_deductions NUMERIC(12,2) GENERATED ALWAYS AS (emp_pf+emp_esi+prof_tax+tds+lwf+other_deductions) STORED,
  net_salary      NUMERIC(12,2) GENERATED ALWAYS AS (basic+hra+conveyance+medical+special+other_earnings - emp_pf-emp_esi-prof_tax-tds-lwf-other_deductions) STORED,
  reason          TEXT,
  revised_by      TEXT REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Payroll ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payroll (
  id           SERIAL PRIMARY KEY,
  month        INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
  year         INTEGER NOT NULL,
  employee_id  INTEGER NOT NULL REFERENCES employees(id),
  paid_days    INTEGER DEFAULT 0,
  lop_days     INTEGER DEFAULT 0,
  basic        NUMERIC(12,2) DEFAULT 0,
  hra          NUMERIC(12,2) DEFAULT 0,
  conveyance   NUMERIC(12,2) DEFAULT 0,
  medical      NUMERIC(12,2) DEFAULT 0,
  special      NUMERIC(12,2) DEFAULT 0,
  other_earn   NUMERIC(12,2) DEFAULT 0,
  gross        NUMERIC(12,2) DEFAULT 0,
  emp_pf       NUMERIC(12,2) DEFAULT 0,
  emp_esi      NUMERIC(12,2) DEFAULT 0,
  prof_tax     NUMERIC(12,2) DEFAULT 0,
  tds          NUMERIC(12,2) DEFAULT 0,
  other_ded    NUMERIC(12,2) DEFAULT 0,
  total_ded    NUMERIC(12,2) DEFAULT 0,
  net_pay      NUMERIC(12,2) DEFAULT 0,
  er_pf        NUMERIC(12,2) DEFAULT 0,
  er_esi       NUMERIC(12,2) DEFAULT 0,
  gratuity     NUMERIC(12,2) DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'Draft'
                CHECK (status IN ('Draft','Generated','Approved','Locked')),
  locked_by    TEXT REFERENCES users(id),
  locked_at    TIMESTAMPTZ,
  created_by   TEXT REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (employee_id, month, year)
);

-- ── Leave Types ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS leave_types (
  id              SERIAL PRIMARY KEY,
  name            TEXT NOT NULL UNIQUE,
  annual_days     NUMERIC(5,1) DEFAULT 0,
  carry_forward   BOOLEAN DEFAULT FALSE,
  max_carry       NUMERIC(5,1) DEFAULT 0,
  half_day        BOOLEAN DEFAULT TRUE,
  paid            BOOLEAN DEFAULT TRUE,
  active          BOOLEAN DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO leave_types (name, annual_days, carry_forward, paid) VALUES
  ('Casual Leave',     12, FALSE, TRUE),
  ('Sick Leave',       10, FALSE, TRUE),
  ('Earned Leave',     15, TRUE,  TRUE),
  ('Loss of Pay',       0, FALSE, FALSE),
  ('Maternity Leave',  90, FALSE, TRUE),
  ('Paternity Leave',   5, FALSE, TRUE)
ON CONFLICT (name) DO NOTHING;

-- ── Leave Balances ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS leave_balances (
  id           SERIAL PRIMARY KEY,
  employee_id  INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  leave_type_id INTEGER NOT NULL REFERENCES leave_types(id),
  year         INTEGER NOT NULL DEFAULT EXTRACT(YEAR FROM NOW()),
  opening      NUMERIC(5,1) DEFAULT 0,
  accrued      NUMERIC(5,1) DEFAULT 0,
  used         NUMERIC(5,1) DEFAULT 0,
  pending      NUMERIC(5,1) DEFAULT 0,
  closing      NUMERIC(5,1) GENERATED ALWAYS AS (opening + accrued - used) STORED,
  UNIQUE (employee_id, leave_type_id, year)
);

-- ── Leave Requests ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS leave_requests (
  id              SERIAL PRIMARY KEY,
  employee_id     INTEGER NOT NULL REFERENCES employees(id),
  leave_type_id   INTEGER NOT NULL REFERENCES leave_types(id),
  from_date       DATE NOT NULL,
  to_date         DATE NOT NULL,
  days            NUMERIC(5,1) NOT NULL DEFAULT 1,
  half_day        BOOLEAN DEFAULT FALSE,
  reason          TEXT,
  status          TEXT NOT NULL DEFAULT 'Submitted'
                  CHECK (status IN ('Draft','Submitted','Manager Approved','HR Approved','Rejected','Cancelled')),
  manager_action  TEXT,
  manager_remark  TEXT,
  manager_at      TIMESTAMPTZ,
  hr_action       TEXT,
  hr_remark       TEXT,
  hr_at           TIMESTAMPTZ,
  actioned_by     TEXT REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Attendance enhancements ───────────────────────────────────
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS check_in   TIME;
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS check_out  TIME;
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS overtime   NUMERIC(4,2) DEFAULT 0;
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS remarks    TEXT;
ALTER TABLE attendance DROP CONSTRAINT IF EXISTS attendance_status_check;
ALTER TABLE attendance ADD CONSTRAINT attendance_status_check
  CHECK (status IN ('Present','Absent','Half Day','Leave','Holiday','Weekly Off','Work From Home','On Duty'));

-- ── Audit Logs ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_logs (
  id          SERIAL PRIMARY KEY,
  user_id     TEXT REFERENCES users(id),
  role        TEXT,
  action      TEXT NOT NULL,
  module      TEXT NOT NULL,
  record_id   TEXT,
  old_value   JSONB,
  new_value   JSONB,
  reason      TEXT,
  ip_address  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Notifications ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notifications (
  id          SERIAL PRIMARY KEY,
  user_id     TEXT REFERENCES users(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  message     TEXT NOT NULL,
  type        TEXT DEFAULT 'info',
  read        BOOLEAN DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Indexes for performance ───────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_attendance_emp_date ON attendance(employee_id, date);
CREATE INDEX IF NOT EXISTS idx_payroll_emp_month   ON payroll(employee_id, month, year);
CREATE INDEX IF NOT EXISTS idx_leave_req_emp       ON leave_requests(employee_id);
CREATE INDEX IF NOT EXISTS idx_audit_module        ON audit_logs(module, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_user  ON notifications(user_id, read);
