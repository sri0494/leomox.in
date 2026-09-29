-- ═══════════════════════════════════════════════════════════════
--  LeoMox HRMS — Migration v2 (enhanced HRMS)
--  Run AFTER schema.sql and migrate.sql.  Safe to run repeatedly.
--  Either paste into the Neon SQL Editor, or run:  npm run db:migrate
-- ═══════════════════════════════════════════════════════════════

-- ── One bank record and one statutory record per employee ─────
-- (migrate.sql created these tables without a UNIQUE(employee_id))
CREATE UNIQUE INDEX IF NOT EXISTS uq_employee_bank_emp      ON employee_bank(employee_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_employee_statutory_emp ON employee_statutory(employee_id);

-- ── Employee code + one login per employee ────────────────────
UPDATE employees SET emp_code = 'LM' || LPAD(id::text, 4, '0') WHERE emp_code IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_employees_emp_code ON employees(emp_code) WHERE emp_code IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_employees_user_id  ON employees(user_id)  WHERE user_id  IS NOT NULL;

-- ── Payroll needs to hold half-day LOP (was INTEGER) ──────────
ALTER TABLE payroll ALTER COLUMN paid_days TYPE NUMERIC(5,1);
ALTER TABLE payroll ALTER COLUMN lop_days  TYPE NUMERIC(5,1);

-- ── Let users be deleted without orphan-FK errors ─────────────
-- (every user who ever logged in has audit_logs rows referencing them)
ALTER TABLE audit_logs DROP CONSTRAINT IF EXISTS audit_logs_user_id_fkey;
ALTER TABLE audit_logs ADD  CONSTRAINT audit_logs_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE employees DROP CONSTRAINT IF EXISTS employees_user_id_fkey;
ALTER TABLE employees ADD  CONSTRAINT employees_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE leave_requests DROP CONSTRAINT IF EXISTS leave_requests_actioned_by_fkey;
ALTER TABLE leave_requests ADD  CONSTRAINT leave_requests_actioned_by_fkey
  FOREIGN KEY (actioned_by) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE payroll DROP CONSTRAINT IF EXISTS payroll_locked_by_fkey;
ALTER TABLE payroll ADD  CONSTRAINT payroll_locked_by_fkey
  FOREIGN KEY (locked_by) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE payroll DROP CONSTRAINT IF EXISTS payroll_created_by_fkey;
ALTER TABLE payroll ADD  CONSTRAINT payroll_created_by_fkey
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE employee_salary DROP CONSTRAINT IF EXISTS employee_salary_revised_by_fkey;
ALTER TABLE employee_salary ADD  CONSTRAINT employee_salary_revised_by_fkey
  FOREIGN KEY (revised_by) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE user_permissions DROP CONSTRAINT IF EXISTS user_permissions_granted_by_fkey;
ALTER TABLE user_permissions ADD  CONSTRAINT user_permissions_granted_by_fkey
  FOREIGN KEY (granted_by) REFERENCES users(id) ON DELETE SET NULL;

-- ── Manager reference must not block deleting the manager ─────
ALTER TABLE employees DROP CONSTRAINT IF EXISTS employees_manager_id_fkey;
ALTER TABLE employees ADD  CONSTRAINT employees_manager_id_fkey
  FOREIGN KEY (manager_id) REFERENCES employees(id) ON DELETE SET NULL;

-- ── Helpful indexes ───────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_attendance_date     ON attendance(date);
CREATE INDEX IF NOT EXISTS idx_leave_req_status    ON leave_requests(status);
CREATE INDEX IF NOT EXISTS idx_employees_status    ON employees(status);
