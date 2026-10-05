-- =============================================================================
-- TrustCom security lockdown - PHASED, re-runnable, reversible.
--
-- Run this in the Supabase SQL Editor. Read all of section 2 before section 4.
--
-- WHY THIS IS NEEDED
--   The site authenticates with a custom `sessions` token, not Supabase Auth,
--   so PostgREST sees every caller as the same `anon` role. RLS therefore
--   cannot tell callers apart, which is why every policy in this project
--   degenerated to USING (true). Combined with a publicly readable anon key
--   that means: anyone can read every row (including password hashes and KYC
--   images) and can insert/update/delete anything.
--
--   The fix is to move authentication and every privileged write behind an
--   Edge Function holding the service-role key, and to leave `anon` read-only.
--
-- ORDER OF OPERATIONS (do not reorder)
--   1. Rotate the service-role key: Supabase -> Project Settings -> API.
--      The old key was published at /supabase/service-key.txt.
--   2. Deploy the Edge Function:  supabase functions deploy secure-api
--   3. Run section 1 and section 3 of this file (safe, additive).
--   4. Ship the updated client (app.js / scripts/db.js) that calls the
--      function instead of writing directly.
--   5. ONLY THEN run section 4. Running section 4 before step 4 breaks the
--      site: nothing will be able to write any more.
-- =============================================================================


-- =============================================================================
-- SECTION 1 - safe to run now (additive only, breaks nothing)
-- =============================================================================

create extension if not exists pgcrypto;

-- Password hashes the browser can never read.
-- RLS is on and no anon policy exists, so `anon` gets nothing.
-- service_role bypasses RLS, so the Edge Function still works.
create table if not exists public.auth_credentials (
  account    text primary key,
  uid        integer,
  pw_hash    text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.auth_credentials enable row level security;
revoke all on public.auth_credentials from anon, authenticated;

-- Admin panel password as a hash. Replaces the plaintext copy that used to
-- live inside admin_settings.config, which `anon` was allowed to SELECT.
create table if not exists public.admin_secret (
  id         boolean primary key default true check (id),
  pw_hash    text not null,
  updated_at timestamptz not null default now()
);
alter table public.admin_secret enable row level security;
revoke all on public.admin_secret from anon, authenticated;

-- Audit trail for privileged actions. There was none before.
create table if not exists public.admin_audit_log (
  id            bigint generated always as identity primary key,
  actor_uid     integer,
  actor_account text,
  action        text not null,
  target_type   text,
  target_id     text,
  detail        jsonb,
  created_at    timestamptz not null default now()
);
create index if not exists admin_audit_log_created_idx
  on public.admin_audit_log (created_at desc);
alter table public.admin_audit_log enable row level security;
revoke all on public.admin_audit_log from anon, authenticated;

grant all on public.auth_credentials to service_role;
grant all on public.admin_secret     to service_role;
grant all on public.admin_audit_log  to service_role;


-- -----------------------------------------------------------------------------
-- SECTION 1b - helpers used by the Edge Function
-- -----------------------------------------------------------------------------
-- bcrypt lives in the database so the plain password never has to be hashed
-- or stored anywhere in the browser. `anon` cannot call these: EXECUTE is
-- revoked below, and only the service-role function holds the key.

create or replace function public.gen_password_hash(p text)
returns text
language sql
security definer
set search_path = public, extensions, pg_temp
as $$ select crypt(p, gen_salt('bf', 12)) $$;

create or replace function public.verify_password(p_account text, p_password text)
returns table (ok boolean, uid bigint)
language sql
security definer
set search_path = public, extensions, pg_temp
as $$
  select (c.pw_hash = crypt(p_password, c.pw_hash)) as ok, c.uid as uid
  from public.auth_credentials c
  where c.account = p_account
  limit 1
$$;

create or replace function public.verify_admin_password(p_password text)
returns table (ok boolean)
language sql
security definer
set search_path = public, extensions, pg_temp
as $$
  select (s.pw_hash = crypt(p_password, s.pw_hash)) as ok
  from public.admin_secret s
  where s.id = true
  limit 1
$$;

revoke all on function public.gen_password_hash(text)      from public, anon, authenticated;
revoke all on function public.verify_password(text, text) from public, anon, authenticated;
revoke all on function public.verify_admin_password(text)  from public, anon, authenticated;

grant execute on function public.gen_password_hash(text)      to service_role;
grant execute on function public.verify_password(text, text) to service_role;
grant execute on function public.verify_admin_password(text)  to service_role;


-- =============================================================================
-- SECTION 2 - why the client must change before section 4
-- =============================================================================
-- Every one of these policies lets the public anon key write to a table:
--
--   anon_register            users           INSERT  <- is_admin:true allowed
--   anon_update_users        users           UPDATE
--   anon_delete_users        users           DELETE
--   anon_insert/update/delete_user_balances
--   anon_insert/update/delete_verifications
--   anon_insert/update/delete_loans
--   anon_insert/update/delete_txns          transactions
--   anon_insert/update/delete_trades
--   anon_insert/update/delete_ai            ai_orders
--   anon_insert/update/delete_chat          chat_messages
--   anon_insert/update/delete_addresses     coin_addresses
--   anon_insert/update_settings             admin_settings
--   anon_sessions_all         sessions       ALL
--
-- `anon_register ... WITH CHECK (true)` is privilege escalation on its own:
-- POST {account, is_admin:true} to /rest/v1/users with the public key and you
-- are an administrator.
--
-- Section 4 drops all of them.


-- =============================================================================
-- SECTION 3 - migrate existing data into the new tables
-- =============================================================================

-- Re-hash every existing password with bcrypt.
--
-- The old scheme was  'hash_' + base64(password + ':' + created_at[:10]),
-- which is encoding, not hashing: base64-decoding a row returns the password
-- in clear text. Strip the prefix, decode, take the part before the colon,
-- and store a real bcrypt hash instead.
-- The old value is base64("password" || ':' || YYYY-MM-DD). Strip the prefix,
-- decode, then remove the fixed 11-character ":YYYY-MM-DD" suffix from the
-- right, so a password that itself contains a colon survives intact.
insert into public.auth_credentials (account, uid, pw_hash)
select
  u.account,
  u.uid,
  crypt(
    left(
      convert_from(decode(substring(u.password_hash from 6), 'base64'), 'UTF8'),
      length(convert_from(decode(substring(u.password_hash from 6), 'base64'), 'UTF8')) - 11
    ),
    gen_salt('bf', 12)
  )
from public.users u
where u.password_hash like 'hash\_%'
on conflict (account) do update
  set pw_hash    = excluded.pw_hash,
      uid        = excluded.uid,
      updated_at = now();

-- Verify the migration preserved every password: re-derive the clear text from
-- the OLD column and confirm it still verifies against the new bcrypt hash.
-- Expect one row per migrated account, all verified = true.
-- If any row is false, the account cannot be signed in - stop and investigate.
select
  c.account,
  crypt(
    left(
      convert_from(decode(substring(u.password_hash from 6), 'base64'), 'UTF8'),
      length(convert_from(decode(substring(u.password_hash from 6), 'base64'), 'UTF8')) - 11
    ),
    c.pw_hash) = c.pw_hash as verified
from public.auth_credentials c
join public.users u on u.account = c.account
order by c.account;

-- Record the current admin password as a hash so the plaintext copy in
-- admin_settings can be deleted afterwards.
insert into public.admin_secret (id, pw_hash)
values (true, crypt('admin123', gen_salt('bf', 12)))
on conflict (id) do update
  set pw_hash    = excluded.pw_hash,
      updated_at = now();


-- =============================================================================
-- SECTION 4 - DO NOT RUN UNTIL SECTION 2's CLIENT CHANGES ARE LIVE
-- =============================================================================
-- Everything below removes a write path that `anon` currently has. If the
-- site still writes directly with the anon key when you run this, login,
-- signup, deposits, withdrawals, trades, KYC and every admin action will fail.
--
-- To roll back, re-run supabase/rls_fix.sql. That restores the wide-open
-- policies, so only do that while you are still fixing the site.

-- signup must go through the Edge Function too, otherwise anyone can
-- self-register as an administrator.
drop policy if exists "anon_register"               on public.users;

drop policy if exists "anon_update_users"           on public.users;
drop policy if exists "anon_delete_users"           on public.users;
drop policy if exists "auth_select_own"             on public.users;

drop policy if exists "anon_select_own_bal"         on public.user_balances;
drop policy if exists "anon_select_own_balances"    on public.user_balances;
drop policy if exists "anon_insert_user_balances"   on public.user_balances;
drop policy if exists "anon_update_user_balances"   on public.user_balances;
drop policy if exists "anon_delete_user_balances"   on public.user_balances;

drop policy if exists "anon_select_own_verifications" on public.verifications;
drop policy if exists "anon_insert_verifications"     on public.verifications;
drop policy if exists "anon_update_verifications"     on public.verifications;
drop policy if exists "anon_delete_verifications"     on public.verifications;

drop policy if exists "anon_select_own_loans"   on public.loans;
drop policy if exists "anon_insert_loans"       on public.loans;
drop policy if exists "anon_update_loans"       on public.loans;
drop policy if exists "anon_delete_loans"       on public.loans;

drop policy if exists "anon_select_own_txns"    on public.transactions;
drop policy if exists "anon_insert_txns"        on public.transactions;
drop policy if exists "anon_update_txns"        on public.transactions;
drop policy if exists "anon_delete_txns"        on public.transactions;

drop policy if exists "anon_select_own_trades"  on public.trades;
drop policy if exists "anon_insert_trades"      on public.trades;
drop policy if exists "anon_update_trades"      on public.trades;
drop policy if exists "anon_delete_trades"      on public.trades;

drop policy if exists "anon_select_own_ai"      on public.ai_orders;
drop policy if exists "anon_insert_ai"          on public.ai_orders;
drop policy if exists "anon_update_ai"          on public.ai_orders;
drop policy if exists "anon_delete_ai"          on public.ai_orders;

drop policy if exists "anon_select_own_chat"    on public.chat_messages;
drop policy if exists "anon_insert_own_chat"    on public.chat_messages;
drop policy if exists "anon_update_chat"        on public.chat_messages;
drop policy if exists "anon_delete_chat"        on public.chat_messages;

drop policy if exists "anon_read_addresses"     on public.coin_addresses;
drop policy if exists "public_read_addresses"   on public.coin_addresses;
drop policy if exists "anon_insert_addresses"   on public.coin_addresses;
drop policy if exists "anon_update_addresses"   on public.coin_addresses;
drop policy if exists "anon_delete_addresses"   on public.coin_addresses;

-- Dropping the read policy on admin_settings hides the plaintext admin
-- password from the public key.
drop policy if exists "anon_select_settings"     on public.admin_settings;
drop policy if exists "anon_insert_settings"     on public.admin_settings;
drop policy if exists "anon_update_settings"     on public.admin_settings;

drop policy if exists "anon_sessions_all"       on public.sessions;

-- Section 5 is separate because reading the user's own balance still needs a
-- decision: PostgREST cannot tell one anon caller from another, so leaving
-- SELECT open on user_balances means every visitor can read every balance.
-- Keep it open only if you accept that, otherwise route reads through the
-- function too and drop:
--
--   drop policy if exists "anon_select_own_balances" on public.user_balances;

-- Confirm what is left: every table should show service_role policies only.
--   select tablename, policyname, roles, cmd
--   from pg_policies
--   where schemaname = 'public'
--   order by tablename, policyname;