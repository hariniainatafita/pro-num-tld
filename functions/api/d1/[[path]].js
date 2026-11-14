// Adaptateur Cloudflare D1 compatible PostgREST pour la table virtuelle
// `app_state`. C'est le fournisseur de secours le plus simple quand le site
// tourne deja sur Cloudflare : aucune inscription externe, palier gratuit
// genereux (5 Go de stockage, 100 000 ecritures/jour).
//
// Configuration Cloudflare Pages :
//   1. Cloudflare Dashboard > Workers & Pages > D1 > Create database
//   2. Pages > pro-num-tld > Settings > Functions > D1 bindings :
//        Variable name: DB  ->  base creee
//   3. Redeployer. La table est creee automatiquement au premier appel.
//
// Le fournisseur s'utilise via /api/d1/0 (le numero est ignore).

import {
  createAppStateHandler,
  corsHeaders,
  QuotaError,
  quotaFromText,
  pickOldestDisposable
} from '../../_lib/appStateStore.js';

function d1Error(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (quotaFromText(message)) return new QuotaError(message);
  return new Error(message);
}

function createStore(env) {
  const db = env.DB;
  if (!db) return null;
  let ready = false;

  async function ensureTable() {
    if (ready) return;
    await db
      .prepare(
        'CREATE TABLE IF NOT EXISTS app_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)'
      )
      .run();
    await db
      .prepare(
        'CREATE INDEX IF NOT EXISTS app_state_updated_at_idx ON app_state (updated_at)'
      )
      .run();
    ready = true;
  }

  async function safe(operation) {
    try {
      await ensureTable();
      return await operation();
    } catch (error) {
      throw d1Error(error);
    }
  }

  async function get(_index, key) {
    return safe(async () => {
      const row = await db
        .prepare('SELECT key, value, updated_at FROM app_state WHERE key = ?')
        .bind(key)
        .first();
      return row || null;
    });
  }

  async function mget(_index, keys) {
    if (keys.length === 0) return [];
    return safe(async () => {
      const placeholders = keys.map(() => '?').join(',');
      const result = await db
        .prepare(
          `SELECT key, value, updated_at FROM app_state WHERE key IN (${placeholders})`
        )
        .bind(...keys)
        .all();
      return result.results || [];
    });
  }

  async function list(_index, limit) {
    return safe(async () => {
      const result = await db
        .prepare(
          'SELECT key, value, updated_at FROM app_state ORDER BY updated_at DESC LIMIT ?'
        )
        .bind(limit)
        .all();
      return result.results || [];
    });
  }

  async function put(_index, entries) {
    return safe(async () => {
      const saved = [];
      for (const entry of entries) {
        const updatedAt =
          typeof entry.updated_at === 'string'
            ? entry.updated_at
            : new Date().toISOString();
        const value = JSON.stringify(entry.value ?? null);
        await db
          .prepare(
            'INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?) ' +
              'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
          )
          .bind(entry.key, value, updatedAt)
          .run();
        saved.push({ key: entry.key, value: entry.value ?? null, updated_at: updatedAt });
      }
      return saved;
    });
  }

  async function remove(_index, key) {
    return safe(async () => {
      await db.prepare('DELETE FROM app_state WHERE key = ?').bind(key).run();
      return [];
    });
  }

  async function evict(_index, limit) {
    return safe(async () => {
      const result = await db
        .prepare(
          'SELECT key, updated_at FROM app_state ORDER BY updated_at ASC LIMIT ?'
        )
        .bind(Math.max(limit * 5, 200))
        .all();
      const victims = pickOldestDisposable(result.results || [], limit);
      if (victims.length === 0) return 0;
      const placeholders = victims.map(() => '?').join(',');
      await db
        .prepare(`DELETE FROM app_state WHERE key IN (${placeholders})`)
        .bind(...victims.map((victim) => victim.key))
        .run();
      return victims.length;
    });
  }

  async function health() {
    return safe(async () => {
      const row = await db.prepare('SELECT COUNT(*) AS count FROM app_state').first();
      return { ok: true, keys: row ? Number(row.count) || 0 : 0 };
    });
  }

  return { get, mget, list, put, remove, evict, health };
}

export const onRequest = createAppStateHandler({
  label: 'd1',
  getStore: createStore
});

export async function onRequestOptions({ request }) {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}
