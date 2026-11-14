// Adaptateur Firebase Realtime Database compatible PostgREST pour la table
// virtuelle `app_state`. Il s'ajoute derriere le proxy de bascule
// (functions/api/db/[[path]].js) comme les autres fournisseurs.
//
// Configuration Cloudflare Pages (Variables and Secrets) :
//   FIREBASE_RTDB_URL=https://xxxx-default-rtdb.firebaseio.com
//   FIREBASE_RTDB_SECRET=...        (optionnel, si les regles ne sont pas
//                                    publiques : ajoute ?auth=...)
// Plusieurs bases (bascule) :
//   FIREBASE_RTDB=[{"url":"https://a.firebaseio.com","secret":"..."},
//                  {"url":"https://b.firebaseio.com"}]
// Le chemin /api/firebase/<index>/... selectionne la base (0 par defaut).
//
// Modele : app_state/<cle>    = { key, value: "<json>", updated_at }
//          app_state_index/<cle> = "<updated_at>"
// Cela evite de telecharger les images (qui ont leur propre cle) lors d'une
// simple lecture de l'index.

import {
  createAppStateHandler,
  corsHeaders,
  QuotaError,
  quotaFromText,
  pickOldestDisposable
} from '../../_lib/appStateStore.js';

function encodeKey(key) {
  // Les cles RTDB interdisent . # $ [ ] / : tout est encode.
  return encodeURIComponent(key).replace(/\./g, '%2E');
}

function docUrl(target, path) {
  const base = target.url.replace(/\/+$/, '');
  const url = new URL(`${base}/${path}.json`);
  if (target.secret) url.searchParams.set('auth', target.secret);
  return url.toString();
}

async function rtdbFetch(url, init) {
  const response = await fetch(url, init);
  if (response.status === 402 || response.status === 429 || response.status === 507) {
    throw new QuotaError(`firebase ${response.status}`);
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    if (quotaFromText(text)) throw new QuotaError(text);
    throw new Error(`firebase ${response.status}: ${text.slice(0, 200)}`);
  }
  if (response.status === 204) return null;
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

let targetsCache = { raw: '', targets: [] };

function readTargets(env) {
  const list = typeof env.FIREBASE_RTDB === 'string' ? env.FIREBASE_RTDB.trim() : '';
  const urls = typeof env.FIREBASE_RTDB_URLS === 'string' ? env.FIREBASE_RTDB_URLS.trim() : '';
  const single = typeof env.FIREBASE_RTDB_URL === 'string' ? env.FIREBASE_RTDB_URL.trim() : '';
  const secret = typeof env.FIREBASE_RTDB_SECRET === 'string' ? env.FIREBASE_RTDB_SECRET.trim() : '';
  const raw = `${list}|${urls}|${single}|${secret}`;
  if (targetsCache.raw === raw) return targetsCache.targets;

  let entries = [];
  try {
    if (list) {
      const parsed = JSON.parse(list);
      entries = Array.isArray(parsed) ? parsed : [parsed];
    } else if (urls) {
      const parsed = JSON.parse(urls);
      entries = Array.isArray(parsed) ? parsed : [parsed];
    } else if (single) {
      entries = [{ url: single, secret }];
    }
  } catch {
    console.warn('FIREBASE_RTDB: JSON invalide');
    entries = [];
  }

  const targets = entries
    .map((entry) => {
      if (typeof entry === 'string') return { url: entry, secret };
      if (!entry || typeof entry.url !== 'string') return null;
      return { url: entry.url, secret: entry.secret || secret };
    })
    .filter(Boolean)
    .map((entry) => ({ url: entry.url.replace(/\/+$/, ''), secret: entry.secret || '' }));

  targetsCache = { raw, targets };
  return targets;
}

function createStore(env) {
  const targets = readTargets(env);
  if (targets.length === 0) return null;
  const pick = (index) => targets[index] || targets[0];

  async function get(index, key) {
    const target = pick(index);
    const data = await rtdbFetch(docUrl(target, `app_state/${encodeKey(key)}`));
    if (!data || typeof data !== 'object') return null;
    return {
      key,
      value: data.value,
      updated_at: typeof data.updated_at === 'string' ? data.updated_at : ''
    };
  }

  async function mget(index, keys) {
    const rows = await Promise.all(keys.map((key) => get(index, key).catch(() => null)));
    return rows.filter(Boolean);
  }

  async function list(index, limit) {
    const target = pick(index);
    const indexRows = await rtdbFetch(docUrl(target, 'app_state_index'));
    if (!indexRows || typeof indexRows !== 'object') return [];
    const keys = Object.keys(indexRows)
      .sort((a, b) => (Date.parse(indexRows[b]) || 0) - (Date.parse(indexRows[a]) || 0))
      .slice(0, limit);
    return mget(index, keys);
  }

  async function put(index, entries) {
    const target = pick(index);
    const saved = [];
    for (const entry of entries) {
      const updatedAt =
        typeof entry.updated_at === 'string'
          ? entry.updated_at
          : new Date().toISOString();
      const payload = {
        key: entry.key,
        value: JSON.stringify(entry.value ?? null),
        updated_at: updatedAt
      };
      await rtdbFetch(docUrl(target, `app_state/${encodeKey(entry.key)}`), {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      });
      await rtdbFetch(docUrl(target, `app_state_index/${encodeKey(entry.key)}`), {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(updatedAt)
      });
      saved.push({ key: entry.key, value: entry.value ?? null, updated_at: updatedAt });
    }
    return saved;
  }

  async function remove(index, key) {
    const target = pick(index);
    await rtdbFetch(docUrl(target, `app_state/${encodeKey(key)}`), { method: 'DELETE' });
    await rtdbFetch(docUrl(target, `app_state_index/${encodeKey(key)}`), {
      method: 'DELETE'
    });
    return [];
  }

  async function evict(index, limit) {
    const target = pick(index);
    const indexRows = await rtdbFetch(docUrl(target, 'app_state_index'));
    if (!indexRows || typeof indexRows !== 'object') return 0;
    const rows = Object.keys(indexRows).map((key) => ({
      key,
      updated_at: indexRows[key]
    }));
    const victims = pickOldestDisposable(rows, limit);
    await Promise.all(
      victims.map(async (victim) => {
        await rtdbFetch(docUrl(target, `app_state/${encodeKey(victim.key)}`), {
          method: 'DELETE'
        }).catch(() => null);
        await rtdbFetch(docUrl(target, `app_state_index/${encodeKey(victim.key)}`), {
          method: 'DELETE'
        }).catch(() => null);
      })
    );
    return victims.length;
  }

  async function health(index) {
    const target = pick(index);
    const data = await rtdbFetch(docUrl(target, 'app_state_index'));
    return { ok: true, url: target.url, keys: data && typeof data === 'object' ? Object.keys(data).length : 0 };
  }

  return { get, mget, list, put, remove, evict, health };
}

export const onRequest = createAppStateHandler({
  label: 'firebase',
  getStore: createStore
});

export async function onRequestOptions({ request }) {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}
