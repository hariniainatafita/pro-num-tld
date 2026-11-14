// Adaptateur Upstash Redis compatible PostgREST pour la table virtuelle
// `app_state`. Upstash expose une API REST (pas besoin de connexion TCP), ce
// qui fonctionne parfaitement dans Cloudflare Workers.
//
// Configuration Cloudflare Pages :
//   UPSTASH_REDIS_REST_URL=https://xxxx.upstash.io
//   UPSTASH_REDIS_REST_TOKEN=...
// Plusieurs bases (bascule) :
//   UPSTASH_REDIS=[{"url":"https://a.upstash.io","token":"..."},
//                  {"url":"https://b.upstash.io","token":"..."}]
// Le chemin /api/upstash/<index>/... selectionne la base (0 par defaut).
//
// Donnees :
//   appstate:<cle>      -> JSON { key, value: "<json>", updated_at }
//   appstate:index      -> sorted set (score = updated_at en ms, membre = cle)

import {
  createAppStateHandler,
  corsHeaders,
  QuotaError,
  quotaFromText,
  pickOldestDisposable
} from '../../_lib/appStateStore.js';

const DATA_PREFIX = 'appstate:';
const INDEX_KEY = 'appstate:index';

function dataKey(key) {
  return `${DATA_PREFIX}${key}`;
}

async function upstashFetch(target, commands) {
  const response = await fetch(`${target.url.replace(/\/+$/, '')}/pipeline`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${target.token}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify(commands),
    signal: AbortSignal.timeout(20_000)
  });
  if (response.status === 402 || response.status === 429 || response.status === 507) {
    throw new QuotaError(`upstash ${response.status}`);
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    if (quotaFromText(text)) throw new QuotaError(text);
    throw new Error(`upstash ${response.status}: ${text.slice(0, 200)}`);
  }
  const payload = await response.json().catch(() => []);
  const results = Array.isArray(payload) ? payload : [payload];
  for (const item of results) {
    if (item && item.error) {
      const message = String(item.error);
      if (quotaFromText(message)) throw new QuotaError(message);
      throw new Error(message);
    }
  }
  return results.map((item) => (item ? item.result : null));
}

function parseRow(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const row = JSON.parse(raw);
    if (!row || typeof row.key !== 'string') return null;
    return row;
  } catch {
    return null;
  }
}

let targetsCache = { raw: '', targets: [] };

function readTargets(env) {
  const list = typeof env.UPSTASH_REDIS === 'string' ? env.UPSTASH_REDIS.trim() : '';
  const url = typeof env.UPSTASH_REDIS_REST_URL === 'string' ? env.UPSTASH_REDIS_REST_URL.trim() : '';
  const token =
    typeof env.UPSTASH_REDIS_REST_TOKEN === 'string'
      ? env.UPSTASH_REDIS_REST_TOKEN.trim()
      : '';
  const raw = `${list}|${url}|${token}`;
  if (targetsCache.raw === raw) return targetsCache.targets;

  let entries = [];
  try {
    if (list) {
      const parsed = JSON.parse(list);
      entries = Array.isArray(parsed) ? parsed : [parsed];
    } else if (url && token) {
      entries = [{ url, token }];
    }
  } catch {
    console.warn('UPSTASH_REDIS: JSON invalide');
    entries = [];
  }

  const targets = entries
    .filter((entry) => entry && typeof entry.url === 'string')
    .map((entry) => ({
      url: entry.url.replace(/\/+$/, ''),
      token: typeof entry.token === 'string' ? entry.token : token
    }));

  targetsCache = { raw, targets };
  return targets;
}

function createStore(env) {
  const targets = readTargets(env);
  if (targets.length === 0) return null;
  const pick = (index) => targets[index] || targets[0];

  async function get(index, key) {
    const target = pick(index);
    const [raw] = await upstashFetch(target, [['GET', dataKey(key)]]);
    return parseRow(raw);
  }

  async function mget(index, keys) {
    if (keys.length === 0) return [];
    const target = pick(index);
    const [rawRows] = await upstashFetch(target, [['MGET', ...keys.map(dataKey)]]);
    if (!Array.isArray(rawRows)) return [];
    return rawRows.map(parseRow).filter(Boolean);
  }

  async function list(index, limit) {
    const target = pick(index);
    const [keys] = await upstashFetch(target, [
      ['ZREVRANGE', INDEX_KEY, '0', String(Math.max(0, limit - 1))]
    ]);
    if (!Array.isArray(keys) || keys.length === 0) return [];
    return mget(index, keys);
  }

  async function put(index, entries) {
    const target = pick(index);
    const commands = [];
    const saved = [];
    for (const entry of entries) {
      const updatedAt =
        typeof entry.updated_at === 'string'
          ? entry.updated_at
          : new Date().toISOString();
      const score = Date.parse(updatedAt) || Date.now();
      const row = {
        key: entry.key,
        value: JSON.stringify(entry.value ?? null),
        updated_at: updatedAt
      };
      commands.push(['SET', dataKey(entry.key), JSON.stringify(row)]);
      commands.push(['ZADD', INDEX_KEY, String(score), entry.key]);
      saved.push({ key: entry.key, value: entry.value ?? null, updated_at: updatedAt });
    }
    await upstashFetch(target, commands);
    return saved;
  }

  async function remove(index, key) {
    const target = pick(index);
    await upstashFetch(target, [
      ['DEL', dataKey(key)],
      ['ZREM', INDEX_KEY, key]
    ]);
    return [];
  }

  async function evict(index, limit) {
    const target = pick(index);
    const [raw] = await upstashFetch(target, [
      ['ZRANGE', INDEX_KEY, '0', String(Math.max(0, limit * 5 - 1)), 'WITHSCORES']
    ]);
    if (!Array.isArray(raw)) return 0;
    const rows = [];
    for (let i = 0; i < raw.length; i += 2) {
      const key = raw[i];
      const score = Number(raw[i + 1]);
      if (typeof key !== 'string') continue;
      rows.push({
        key,
        updated_at: Number.isFinite(score) ? new Date(score).toISOString() : ''
      });
    }
    const victims = pickOldestDisposable(rows, limit);
    if (victims.length === 0) return 0;
    const commands = [];
    for (const victim of victims) {
      commands.push(['DEL', dataKey(victim.key)]);
      commands.push(['ZREM', INDEX_KEY, victim.key]);
    }
    await upstashFetch(target, commands);
    return victims.length;
  }

  async function health(index) {
    const target = pick(index);
    const [pong] = await upstashFetch(target, [['PING']]);
    return { ok: pong === 'PONG', url: target.url };
  }

  return { get, mget, list, put, remove, evict, health };
}

export const onRequest = createAppStateHandler({
  label: 'upstash',
  getStore: createStore
});

export async function onRequestOptions({ request }) {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}
