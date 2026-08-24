--- Up migration
-- Authorization flag for the admin monitoring backend (#280). This column is
-- the sole authority `adminMiddleware` reads; there is no environment
-- allow-list beside it, and no HTTP endpoint sets it (`is_admin` is absent
-- from the repository's `update` allow-list). Promotion is a deliberate DB
-- write, documented in docs/DEVELOPMENT.md.
--
-- NOT NULL DEFAULT false backfills every existing row as a non-admin, so no
-- separate backfill statement is needed and no account gains privilege by
-- being migrated. Rolling this back drops the flags themselves, not just the
-- column, so a re-applied migration starts from zero admins.
ALTER TABLE users
  ADD COLUMN is_admin BOOLEAN NOT NULL DEFAULT false;

--- Down migration
ALTER TABLE users
  DROP COLUMN is_admin;
