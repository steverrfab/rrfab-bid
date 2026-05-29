-- Promote Steve to superadmin. Idempotent — only runs if currently admin or estimator.
UPDATE users SET role = 'superadmin' WHERE email = 'stevem@rrfabrication.org' AND role IN ('admin', 'estimator');
