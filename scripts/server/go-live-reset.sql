-- Go-live reset (DOC-2, docs/runbooks/go-live-reset.md step 3): DROP the TRIAL application database and CREATE it again,
-- empty, with every grant and default privilege for the SAME three roles (owner, runtime, backup), so `npm run migrate`
-- then builds a database the runtime role can use, the backup role can read, and STRICT_DB_ROLES accepts.
--
-- Run on the server as the PostgreSQL admin, connected to the `postgres` database, never as one of the three roles:
--
--   sudo -u postgres psql -X -v ON_ERROR_STOP=1 \
--     -v db=jewelry_erp -v db_confirm=jewelry_erp -v trial_gm=<username of the TRIAL General Manager> \
--     -f /srv/jerp/app/scripts/server/go-live-reset.sql
--
-- Optional: -v owner=… -v runtime=… -v backup=… (defaults jerp_owner, jerp_app, jerp_backup).
--
-- It refuses, and changes NOTHING, unless every guard holds:
--   * the database name is given twice and both agree (db, db_confirm);
--   * the names are plain lower-case identifiers, the database is not a system database, and the three roles exist
--     and are three different roles;
--   * the database is the TRIAL database it was told about: its General Manager is `trial_gm`
--     (or the database holds no table at all: an earlier reset that stopped after the drop is simply finished).
-- The roles and their passwords are kept: /etc/jerp.env and /etc/jerp-backup.env stay valid.

\set ON_ERROR_STOP on
\set QUIET on
\set refuse 'DO $$ BEGIN RAISE EXCEPTION ''go-live reset REFUSED: nothing was changed (read the REFUSED line above)''; END $$;'

\if :{?owner}
\else
  \set owner jerp_owner
\endif
\if :{?runtime}
\else
  \set runtime jerp_app
\endif
\if :{?backup}
\else
  \set backup jerp_backup
\endif

\if :{?db}
\else
  \echo 'REFUSED: name the database: -v db=jewelry_erp -v db_confirm=jewelry_erp'
  :refuse
\endif
\if :{?db_confirm}
\else
  \echo 'REFUSED: type the database name a second time: -v db_confirm=' :db
  :refuse
\endif
\if :{?trial_gm}
\else
  \echo 'REFUSED: give the username of the TRIAL General Manager: -v trial_gm=<username>'
  :refuse
\endif

SELECT current_database() AS home_db,
       :'db' = :'db_confirm' AS confirm_ok,
       :'db' ~ '^[a-z_][a-z0-9_]{0,62}$' AND :'owner' ~ '^[a-z_][a-z0-9_]{0,62}$'
         AND :'runtime' ~ '^[a-z_][a-z0-9_]{0,62}$' AND :'backup' ~ '^[a-z_][a-z0-9_]{0,62}$' AS names_ok,
       :'db' NOT IN ('postgres', 'template0', 'template1') AND :'db' <> current_database() AS target_ok,
       (SELECT count(DISTINCT rolname) FROM pg_roles WHERE rolname IN (:'owner', :'runtime', :'backup')) = 3 AS roles_ok,
       EXISTS (SELECT 1 FROM pg_database WHERE datname = :'db') AS db_exists
\gset

\if :confirm_ok
\else
  \echo 'REFUSED: the two database names differ:' :db 'and' :db_confirm
  :refuse
\endif
\if :names_ok
\else
  \echo 'REFUSED: database and role names must be plain lower-case names (letters, digits, underscore)'
  :refuse
\endif
\if :target_ok
\else
  \echo 'REFUSED: the target' :db 'is a system database, or the one this session is connected to (connect to postgres)'
  :refuse
\endif
\if :roles_ok
\else
  \echo 'REFUSED: the three roles must exist and differ:' :owner :runtime :backup '(the reset keeps the existing roles; it never creates them)'
  :refuse
\endif

\if :db_exists
  \connect :db
  SELECT count(*) = 0 AS db_empty FROM pg_tables WHERE schemaname = 'public' \gset
  \if :db_empty
    \echo 'Note: the database' :db 'holds no table (an earlier reset stopped after the drop); it is created again.'
  \else
    SELECT to_regclass('public.users') IS NOT NULL AND to_regclass('public.roles') IS NOT NULL AS has_users \gset
    \if :has_users
      SELECT EXISTS (SELECT 1 FROM users u JOIN roles r ON r.id = u.role_id WHERE u.username = :'trial_gm' AND r.code = 'GENERAL_MANAGER') AS trial_ok \gset
    \else
      \set trial_ok false
    \endif
    \if :trial_ok
      SELECT (SELECT count(*) FROM users) AS n_users, (SELECT count(*) FROM branches) AS n_branches,
             (SELECT count(*) FROM sales) AS n_sales, (SELECT count(*) FROM jewelry_items) AS n_items \gset
      \echo 'The TRIAL database' :db 'of General Manager' :trial_gm 'is dropped now:' :n_users 'users,' :n_branches 'branches,' :n_items 'pieces,' :n_sales 'sales.'
    \else
      \echo 'REFUSED: in the database' :db 'the user' :trial_gm 'is not a General Manager: this is not the trial database you named. Nothing was changed.'
      :refuse
    \endif
  \endif
  \connect :home_db
\endif

-- Every guard held. From here on the database is replaced.
DROP DATABASE IF EXISTS :"db" WITH (FORCE);
CREATE DATABASE :"db";
GRANT CONNECT, CREATE ON DATABASE :"db" TO :"owner";
GRANT CONNECT ON DATABASE :"db" TO :"runtime", :"backup";

\connect :db
-- Schema public (DEPLOYMENT §5): the owner creates the tables; the runtime and backup roles only use them.
GRANT USAGE, CREATE ON SCHEMA public TO :"owner";
GRANT USAGE ON SCHEMA public TO :"runtime", :"backup";
-- Schema drizzle (the migration history): created now, owned by the owner, readable by the runtime role (the
-- preflight and /api/ready read it) and by the backup role. The gap found at the first deploy cannot recur.
CREATE SCHEMA drizzle AUTHORIZATION :"owner";
GRANT USAGE ON SCHEMA drizzle TO :"runtime", :"backup";
-- Every table, sequence and function the migrations create (as the owner) is usable by the runtime role and readable
-- by the backup role (DEPLOYMENT §5 and §7.2). The migrations themselves then take UPDATE, DELETE and TRUNCATE away
-- from the runtime role on every append-only table.
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner" IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO :"runtime";
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner" IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO :"runtime";
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner" IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO :"runtime";
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner" IN SCHEMA public GRANT SELECT ON TABLES TO :"backup";
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner" IN SCHEMA public GRANT SELECT ON SEQUENCES TO :"backup";
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner" IN SCHEMA drizzle GRANT SELECT ON TABLES TO :"runtime", :"backup";
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner" IN SCHEMA drizzle GRANT SELECT ON SEQUENCES TO :"backup";

\echo 'DONE: the database' :db 'is empty, with the grants of' :owner :runtime :backup '. Next: npm run migrate (runbook step 4).'
