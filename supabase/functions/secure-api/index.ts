// =============================================================================
// TrustCom privileged API - Supabase Edge Function (Deno)
//
// Deploy:  supabase functions deploy secure-api --no-verify-jwt
//
// Why this exists: the browser used to write directly to PostgREST with the
// public anon key, and RLS cannot distinguish one anon caller from another.
// So the anon key could read every row (password hashes, KYC photos, balances)
// and write/delete anything, including self-registering as an administrator.
//
// This function is the only thing that holds the service-role key. It derives
// the caller's identity from the `sessions` token alone and never trusts a uid
// supplied by the client. Every privileged action is written to
// admin_audit_log, which the client cannot read.
//
// Request:  POST  { action: string, payload: object }
// Auth:     Authorization: Bearer <session token>
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

// ---------------------------------------------------------------- CORS
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set');
}

const db = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ---------------------------------------------------------------- types
type Actor = {
  token: string;
  uid: number | null;
  account: string | null;
  isAdmin: boolean;
};

const fail = (msg: string, status = 400) => json({ error: msg }, status);

/** Resolve the caller from the bearer token. Identity comes only from here. */
async function authenticate(req: Request): Promise<Actor | null> {
  const raw = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!raw) return null;

  const { data: rows, error } = await db
    .from('sessions')
    .select('token, uid, admin, expires_at')
    .eq('token', raw)
    .limit(1);

  if (error || !rows || rows.length === 0) return null;

  const s = rows[0];
  if (s.expires_at && new Date(s.expires_at).getTime() < Date.now()) return null;

  let account: string | null = null;
  if (s.uid != null) {
    const { data: u } = await db
      .from('users')
      .select('account')
      .eq('uid', s.uid)
      .limit(1);
    account = u && u[0] ? u[0].account : null;
  }

  return { token: s.token, uid: s.uid ?? null, account, isAdmin: !!s.admin };
}

async function audit(a: Actor, action: string, targetType?: string, targetId?: string, detail?: unknown) {
  // Logging must never break the operation it describes.
  try {
    await db.from('admin_audit_log').insert({
      actor_uid: a.uid,
      actor_account: a.account,
      action,
      target_type: targetType ?? null,
      target_id: targetId != null ? String(targetId) : null,
      detail: detail ?? null,
    });
  } catch (e) {
    console.error('audit failed', action, e);
  }
}

const requireUser = (a: Actor | null): Actor => {
  if (!a) throw new Error('unauthenticated');
  return a;
};

const requireAdmin = (a: Actor | null): Actor => {
  const u = requireUser(a);
  if (!u.isAdmin) throw new Error('forbidden');
  return u;
};

// ---------------------------------------------------------------- handlers
type Handler = (actor: Actor, payload: any) => Promise<unknown>;

const handlers: Record<string, Handler> = {
  // ---- auth ------------------------------------------------------------
  'auth.signup': async (_a, p) => {
    const account = String(p.account ?? '').trim();
    const password = String(p.password ?? '');
    if (!account || password.length < 6) throw new Error('invalid input');

    const { data: dupe } = await db.from('users').select('uid').eq('account', account).limit(1);
    if (dupe && dupe.length) throw new Error('account exists');

    // Retry on the (rare) uid collision rather than overwriting an existing user.
    let uid = 0;
    for (let attempt = 0; attempt < 8; attempt++) {
      const candidate = Math.floor(100000 + Math.random() * 899999);
      const { data: clash } = await db.from('users').select('uid').eq('uid', candidate).limit(1);
      if (!clash || !clash.length) { uid = candidate; break; }
    }
    if (!uid) throw new Error('could not allocate uid');

    const hash = await db.rpc('gen_password_hash', { p: password });
    if (hash.error) throw new Error(hash.error.message);

    const now = new Date().toISOString();

    // is_admin is never taken from the payload.
    const { error: uErr } = await db.from('users').insert({
      uid,
      account,
      email: p.email ?? null,
      phone: p.phone ?? null,
      password_hash: null,          // no longer stored on the users row
      is_admin: false,
      status: 'active',
      created_at: now,
      updated_at: now,
    });
    if (uErr) throw new Error(uErr.message);

    const { error: cErr } = await db.from('auth_credentials').insert({
      account,
      uid,
      pw_hash: hash.data,
      created_at: now,
      updated_at: now,
    });
    if (cErr) {
      // Do not leave an account that can never be signed in to.
      await db.from('users').delete().eq('uid', uid);
      throw new Error(cErr.message);
    }

    return { ok: true, uid };
  },

  'auth.login': async (_a, p) => {
    const account = String(p.account ?? '').trim();
    const password = String(p.password ?? '');

    const { data, error } = await db.rpc('verify_password', {
      p_account: account,
      p_password: password,
    });
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) return { ok: false, reason: 'bad_credentials' };
    if (!data[0].ok) return { ok: false, reason: 'bad_credentials' };

    return { ok: true, uid: data[0].uid, account };
  },

  'auth.change_password': async (a, p) => {
    const u = requireUser(a);
    const password = String(p.new_password ?? '');
    if (password.length < 6) throw new Error('password too short');

    const { data, error } = await db.rpc('verify_password', {
      p_account: u.account,
      p_password: String(p.current_password ?? ''),
    });
    if (error) throw new Error(error.message);
    if (!data || !data.length || !data[0].ok) throw new Error('current password incorrect');

    const hash = await db.rpc('gen_password_hash', { p: password });
    if (hash.error) throw new Error(hash.error.message);

    const { error: upErr } = await db
      .from('auth_credentials')
      .update({ pw_hash: hash.data, updated_at: new Date().toISOString() })
      .eq('account', u.account);
    if (upErr) throw new Error(upErr.message);

    await audit(u, 'password_changed', 'users', String(u.uid));
    return { ok: true };
  },

  // ---- session ---------------------------------------------------------
  'session.create': async (_a, p) => {
    const token = String(p.token ?? '').trim();
    if (!token) throw new Error('missing token');
    await db.from('sessions').upsert({ token, uid: null, admin: false, created_at: new Date().toISOString() });
    return { ok: true };
  },

  'session.attach_uid': async (_a, p) => {
    // A token must not be able to claim any uid: prove the password first.
    const token = String(p.token ?? '').trim();
    const { data, error } = await db.rpc('verify_password', {
      p_account: String(p.account ?? '').trim(),
      p_password: String(p.password ?? ''),
    });
    if (error) throw new Error(error.message);
    if (!data || !data.length || !data[0].ok) throw new Error('bad_credentials');
    if (!token) throw new Error('missing token');

    const uid = data[0].uid;
    await db.from('sessions').upsert({
      token,
      uid,
      admin: false,
      created_at: new Date().toISOString(),
    });
    return { ok: true, uid };
  },

  'session.delete': async (_a, p) => {
    const token = String(p.token ?? '').trim();
    if (token) await db.from('sessions').delete().eq('token', token);
    return { ok: true };
  },

  // ---- reads scoped to the caller ---------------------------------------
  'me.read': async (a, _p) => {
    const u = requireUser(a);
    const [profile, balances, txns, trades, kyc] = await Promise.all([
      db.from('users').select('uid,account,email,phone,is_guest,language,greeted,created_at').eq('uid', u.uid).limit(1),
      db.from('user_balances').select('coin,amount,locked_amount').eq('uid', u.uid),
      db.from('transactions').select('*').eq('uid', u.uid).order('created_at', { ascending: false }).limit(100),
      db.from('trades').select('*').eq('uid', u.uid).order('created_at', { ascending: false }).limit(100),
      db.from('verifications').select('*').eq('uid', u.uid).limit(1),
    ]);
    return {
      profile: profile.data?.[0] ?? null,
      balances: balances.data ?? [],
      transactions: txns.data ?? [],
      trades: trades.data ?? [],
      verification: kyc.data?.[0] ?? null,
    };
  },

  // ---- admin -----------------------------------------------------------
  'admin.login': async (_a, p) => {
    const { data, error } = await db.rpc('verify_admin_password', {
      p_password: String(p.password ?? ''),
    });
    if (error) throw new Error(error.message);
    if (!data || !data.length || !data[0].ok) return { ok: false, reason: 'bad_credentials' };
    return { ok: true };
  },

  'admin.grant': async (a, p) => {
    // The admin password is the credential here. Verified before anything is
    // written, so an unauthenticated visitor can still unlock the panel, but
    // only by knowing the password.
    const { data, error } = await db.rpc('verify_admin_password', {
      p_password: String(p.admin_password ?? ''),
    });
    if (error) throw new Error(error.message);
    if (!data || !data.length || !data[0].ok) throw new Error('bad_credentials');

    const token = String(p.token ?? '').trim();
    if (!token) throw new Error('missing token');

    const { error: upErr } = await db.from('sessions').upsert({
      token,
      uid: a ? a.uid : null,
      admin: true,
      created_at: new Date().toISOString(),
    });
    if (upErr) throw new Error(upErr.message);

    await audit(
      a ?? { token, uid: null, account: null, isAdmin: true },
      'admin_unlocked',
      'sessions',
      token.slice(0, 8),
    );
    return { ok: true };
  },

  'admin.list_users': async (a, p) => {
    const admin = requireAdmin(a);
    const limit = Math.min(Number(p.limit) || 200, 1000);
    const { data, error } = await db
      .from('users')
      .select('uid,account,email,phone,is_admin,status,created_at')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw new Error(error.message);
    await audit(admin, 'users_listed', 'users', null, { limit });
    return { users: data ?? [] };
  },

  'admin.set_txn_status': async (a, p) => {
    const admin = requireAdmin(a);
    const id = Number(p.id);
    const status = String(p.status ?? '');
    if (!id || !status) throw new Error('missing input');

    const { data: before } = await db.from('transactions').select('*').eq('id', id).limit(1);
    if (!before || !before.length) throw new Error('not found');

    const { error } = await db.from('transactions').update({ status }).eq('id', id);
    if (error) throw new Error(error.message);

    await audit(admin, 'txn_status_changed', 'transactions', String(id), {
      from: before[0].status,
      to: status,
    });
    return { ok: true };
  },

  'admin.review_kyc': async (a, p) => {
    const admin = requireAdmin(a);
    const id = Number(p.id);
    const decision = p.approved ? 'approved' : 'rejected';
    if (!id) throw new Error('missing input');

    const { data: before } = await db.from('verifications').select('*').eq('id', id).limit(1);
    if (!before || !before.length) throw new Error('not found');

    const { error } = await db.from('verifications').update({ status: decision }).eq('id', id);
    if (error) throw new Error(error.message);

    await audit(admin, 'kyc_reviewed', 'verifications', String(id), { decision });
    return { ok: true };
  },

  'admin.set_loan_status': async (a, p) => {
    const admin = requireAdmin(a);
    const id = Number(p.id);
    const status = String(p.status ?? '');
    if (!id || !status) throw new Error('missing input');

    const { data: before } = await db.from('loans').select('*').eq('id', id).limit(1);
    if (!before || !before.length) throw new Error('not found');

    const { error } = await db.from('loans').update({ status }).eq('id', id);
    if (error) throw new Error(error.message);

    await audit(admin, 'loan_status_changed', 'loans', String(id), {
      from: before[0].status,
      to: status,
    });
    return { ok: true };
  },

  'admin.set_user_admin': async (a, p) => {
    const admin = requireAdmin(a);
    const uid = Number(p.uid);
    const isAdmin = !!p.is_admin;
    if (!uid) throw new Error('missing input');

    const { error } = await db.from('users').update({ is_admin: isAdmin }).eq('uid', uid);
    if (error) throw new Error(error.message);

    await audit(admin, isAdmin ? 'admin_granted' : 'admin_revoked', 'users', String(uid));
    return { ok: true };
  },

  'admin.delete_user': async (a, p) => {
    const admin = requireAdmin(a);
    const uid = Number(p.uid);
    if (!uid) throw new Error('missing input');
    if (uid === admin.uid) throw new Error('cannot delete self');

    const { data: victim } = await db.from('users').select('account').eq('uid', uid).limit(1);
    const account = victim && victim[0] ? victim[0].account : null;

    await Promise.all([
      db.from('user_balances').delete().eq('uid', uid),
      db.from('transactions').delete().eq('uid', uid),
      db.from('trades').delete().eq('uid', uid),
      db.from('loans').delete().eq('uid', uid),
      db.from('verifications').delete().eq('uid', uid),
      db.from('sessions').delete().eq('uid', uid),
      db.from('users').delete().eq('uid', uid),
    ]);
    if (account) await db.from('auth_credentials').delete().eq('account', account);

    await audit(admin, 'user_deleted', 'users', String(uid), { account });
    return { ok: true };
  },

  // ---- public content ---------------------------------------------------
  'public.list_addresses': async () => {
    const { data } = await db
      .from('coin_addresses')
      .select('coin,address,network,qr_code,min_deposit')
      .eq('is_active', true);
    return { addresses: data ?? [] };
  },

  'public.admin_config': async () => {
    // Never return the admin password.
    const { data } = await db.from('admin_settings').select('key,value').eq('key', 'config').limit(1);
    return { config: data && data[0] ? data[0].value : null };
  },

  'public.save_admin_config': async (a, p) => {
    const admin = requireAdmin(a);
    const value = typeof p.value === 'string' ? p.value : JSON.stringify(p.value ?? {});
    const { error } = await db
      .from('admin_settings')
      .upsert({ key: 'config', value, updated_at: new Date().toISOString() });
    if (error) throw new Error(error.message);
    await audit(admin, 'config_saved', 'admin_settings', 'config');
    return { ok: true };
  },
};

// ---------------------------------------------------------------- router
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return fail('method not allowed', 405);

  let action = '';
  let payload: unknown = {};
  try {
    const body = await req.json();
    action = String(body.action ?? '');
    payload = body.payload ?? {};
  } catch {
    return fail('bad json');
  }

  const handler = handlers[action];
  if (!handler) return fail('unknown action', 404);

  try {
    const actor = await authenticate(req);
    const result = await handler(actor ?? ({} as Actor), payload);
    return json({ ok: true, data: result });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (message === 'unauthenticated') return fail('unauthenticated', 401);
    if (message === 'forbidden') return fail('forbidden', 403);
    console.error('action failed', action, message);
    return fail(message, 400);
  }
});