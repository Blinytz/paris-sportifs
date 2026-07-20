// Client Supabase minimal (auth + REST PostgREST + RPC), sans dépendance.
// Session persistée en localStorage, refresh automatique sur 401.

import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

const CLE_SESSION = 'ps_session';
let session = null;
try { session = JSON.parse(localStorage.getItem(CLE_SESSION) || 'null'); } catch { /* session corrompue */ }

function sauverSession(s) {
  session = s;
  if (s) localStorage.setItem(CLE_SESSION, JSON.stringify(s));
  else localStorage.removeItem(CLE_SESSION);
}

export function utilisateur() {
  return session ? session.user : null;
}

export async function connexion(email, motDePasse) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: motDePasse }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error_description || data.msg || 'Connexion refusée');
  sauverSession(data);
  return data.user;
}

export function deconnexion() {
  sauverSession(null);
}

async function rafraichir() {
  if (!session?.refresh_token) return false;
  const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: session.refresh_token }),
  });
  if (!r.ok) { sauverSession(null); return false; }
  sauverSession(await r.json());
  return true;
}

async function appel(path, options = {}, dejaRetente = false) {
  // Authorization : le jeton de session si connecté. Sans session, on
  // n'envoie que l'apikey (compatible avec les clés nouveau format
  // sb_publishable_*, qui ne sont pas des JWT valides pour Bearer).
  const entetes = {
    apikey: SUPABASE_ANON_KEY,
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };
  if (session?.access_token) entetes.Authorization = `Bearer ${session.access_token}`;
  const r = await fetch(`${SUPABASE_URL}${path}`, { ...options, headers: entetes });
  if (r.status === 401 && !dejaRetente && await rafraichir()) {
    return appel(path, options, true);
  }
  if (!r.ok) {
    let message = `Erreur ${r.status}`;
    try { message = (await r.json()).message || message; } catch { /* corps non JSON */ }
    throw new Error(message);
  }
  return r.status === 204 ? null : r.json();
}

// Lecture PostgREST : rest('matches', { status: 'eq.scheduled', ... })
export function rest(table, params = {}) {
  const qs = new URLSearchParams(params).toString();
  return appel(`/rest/v1/${table}${qs ? '?' + qs : ''}`);
}

export function patch(table, params, valeurs) {
  const qs = new URLSearchParams(params).toString();
  return appel(`/rest/v1/${table}?${qs}`, {
    method: 'PATCH',
    body: JSON.stringify(valeurs),
    headers: { Prefer: 'return=minimal' },
  });
}

export function rpc(fonction, args = {}) {
  return appel(`/rest/v1/rpc/${fonction}`, { method: 'POST', body: JSON.stringify(args) });
}
