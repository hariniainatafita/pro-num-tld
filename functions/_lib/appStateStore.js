// Helpers partages par les adaptateurs `app_state` (Firebase, Upstash, D1,
// Neon). Ils exposent le meme sous-ensemble de PostgREST que celui utilise par
// le client Supabase de l'application, afin que le proxy de bascule
// (functions/api/db/[[path]].js) puisse traiter tous les fournisseurs de la
// meme facon.
//
// Politique de liberation : quand un fournisseur est plein, seules les lignes
// jetables (images de messages, stories, publications, avatars) sont
// supprimees, en commencant par les plus anciennes. Les collections metier
// (membres, groupes, finances, mots de passe...) ne sont jamais touchees.

export const DISPOSABLE_PREFIXES = [
  'pronumtld_msgimg_',
  'pronumtld_storyimg_',
  'pronumtld_pubimg_',
  'pronumtld_memberimg_'
];

export const EVICT_BATCH = 200;

export function isDisposableKey(key) {
  return (
    typeof key === 'string' &&
    DISPOSABLE_PREFIXES.some((prefix) => key.startsWith(prefix))
  );
}

export function pickOldestDisposable(rows, limit) {
  return rows
    .filter((row) => row && isDisposableKey(row.key))
    .sort((a, b) => {
      const timeA = Date.parse(a.updated_at || '') || 0;
      const timeB = Date.parse(b.updated_at || '') || 0;
      return timeA - timeB;
    })
    .slice(0, Math.max(0, limit));
}

export class QuotaError extends Error {
  constructor(message = 'stockage plein') {
    super(message);
    this.name = 'QuotaError';
  }
}

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

const CAPACITOR_ORIGINS = new Set([
  'https://localhost',
  'capacitor://localhost',
  'http://localhost'
]);

const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i;

export function isAllowedOrigin(request) {
  const origin = request.headers.get('origin');
  if (!origin) return true;
  if (CAPACITOR_ORIGINS.has(origin)) return true;
  if (LOCAL_ORIGIN.test(origin)) return true;
  try {
    const originHost = new URL(origin).host;
    const requestHost = new URL(request.url).host;
    if (originHost === requestHost) return true;
    if (originHost.endsWith('.pages.dev')) return true;
  } catch {
    return false;
  }
  return false;
}

export function corsHeaders(request) {
  const headers = {
    'access-control-allow-methods': 'GET, POST, PATCH, PUT, DELETE, HEAD, OPTIONS',
    'access-control-allow-headers':
      'apikey, authorization, content-type, prefer, accept, accept-profile, content-profile, x-client-info, x-supabase-api-version, range',
    'access-control-expose-headers': 'content-range, preference-applied, content-profile',
    vary: 'origin'
  };
  const origin = request.headers.get('origin');
  if (origin && isAllowedOrigin(request)) {
    headers['access-control-allow-origin'] = origin;
  }
  return headers;
}

export function json(request, status, payload, extraHeaders = {}) {
  return new Response(payload === undefined ? null : JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json',
      ...corsHeaders(request),
      ...extraHeaders
    }
  });
}

export function pgrstError(request, status, code, message) {
  return json(request, status, { code, message, details: null, hint: null });
}

export function eqValue(searchParams) {
  const raw = searchParams.get('key');
  if (typeof raw === 'string' && raw.startsWith('eq.')) return raw.slice(3);
  return null;
}

// PostgREST `in.(a,b,c)` utilise par `.in('key', SYNCED_KEYS)`.
export function inValues(searchParams) {
  const raw = searchParams.get('key');
  if (typeof raw !== 'string' || !raw.startsWith('in.(') || !raw.endsWith(')')) {
    return null;
  }
  const inner = raw.slice(4, -1).trim();
  if (!inner) return [];
  return inner
    .split(',')
    .map((part) => part.trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean);
}

export function limitValue(searchParams, max = 5000) {
  const raw = Number.parseInt(searchParams.get('limit') || '', 10);
  if (!Number.isFinite(raw) || raw <= 0) return max;
  return Math.min(raw, max);
}

export function isSingle(request) {
  return (request.headers.get('accept') || '').includes('vnd.pgrst.object+json');
}

export function wantsMinimal(request) {
  return (request.headers.get('prefer') || '').includes('return=minimal');
}

export function pickColumn(select, column) {
  if (!select || select === '*') return true;
  return select.split(',').map((part) => part.trim()).includes(column);
}

function decodeValue(value) {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function normalizeRows(rows) {
  return rows.map((row) => ({ ...row, value: decodeValue(row.value) }));
}

export function projectRow(row, select) {
  const out = {};
  if (pickColumn(select, 'key')) out.key = row.key;
  if (pickColumn(select, 'value')) out.value = row.value;
  if (pickColumn(select, 'updated_at')) out.updated_at = row.updated_at;
  return out;
}

export async function readEntries(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    throw new HttpError(400, 'PGRST102', 'corps JSON invalide');
  }
  const entries = Array.isArray(body) ? body : [body];
  if (
    entries.length === 0 ||
    entries.some((entry) => !entry || typeof entry.key !== 'string')
  ) {
    throw new HttpError(400, 'PGRST102', 'chaque entree doit contenir une cle');
  }
  return entries;
}

function singleResult(rows, request, status, select) {
  const projected = normalizeRows(rows).map((row) => projectRow(row, select));
  if (isSingle(request)) {
    if (projected.length !== 1) {
      return pgrstError(
        request,
        406,
        'PGRST116',
        'JSON object requested, multiple (or no) rows returned'
      );
    }
    return json(request, status, projected[0]);
  }
  return json(request, status, projected);
}

async function handleGet(store, index, request, searchParams) {
  const select = searchParams.get('select') || '*';
  const key = eqValue(searchParams);
  const keys = inValues(searchParams);
  let rows;

  if (key !== null) {
    const row = await store.get(index, key);
    rows = row ? [row] : [];
  } else if (keys !== null) {
    rows = keys.length ? await store.mget(index, keys) : [];
  } else {
    rows = await store.list(index, limitValue(searchParams));
  }

  if (isSingle(request)) {
    return singleResult(rows, request, 200, select);
  }
  const projected = normalizeRows(rows).map((row) => projectRow(row, select));
  return json(request, 200, projected, {
    'content-range': `0-${Math.max(projected.length - 1, 0)}/${projected.length}`
  });
}

async function withEviction(store, index, operation) {
  try {
    return await operation();
  } catch (error) {
    if (!(error instanceof QuotaError)) throw error;
    try {
      await store.evict(index, EVICT_BATCH);
    } catch {
      /* la liberation est un bonus : on retente quand meme */
    }
    return operation();
  }
}

async function handlePut(store, index, request, searchParams) {
  const select = searchParams.get('select') || '*';
  const entries = await readEntries(request);
  const rows = await withEviction(store, index, () => store.put(index, entries));

  if (wantsMinimal(request)) {
    return json(request, 201, undefined, {
      'preference-applied': 'resolution=merge-duplicates'
    });
  }
  return singleResult(rows, request, 201, select);
}

async function handleDelete(store, index, request, searchParams) {
  const select = searchParams.get('select') || '*';
  const key = eqValue(searchParams);
  if (!key) {
    throw new HttpError(400, 'PGRST100', 'filtre key=eq.<cle> requis');
  }
  const rows = await withEviction(store, index, () => store.remove(index, key));
  if (wantsMinimal(request)) return json(request, 204, undefined);
  return singleResult(rows, request, 200, select);
}

/**
 * Fabrique un handler Cloudflare compatible PostgREST pour la table
 * `app_state`.
 *
 * @param {{ label: string, getStore: (env: any) => any }} options
 */
export function createAppStateHandler({ label, getStore }) {
  return async function onRequest({ request, env, params }) {
    if (!isAllowedOrigin(request)) {
      return json(request, 403, { error: 'origine refusee' });
    }

    const store = getStore(env);
    if (!store) {
      return json(request, 503, { error: `${label} non configure` });
    }

    const segments = Array.isArray(params.path)
      ? [...params.path]
      : params.path
        ? [params.path]
        : [];
    let index = 0;
    if (segments.length > 1 && /^\d+$/.test(segments[0])) {
      index = Number(segments.shift());
    }
    const path = `/${segments.join('/')}`;
    const searchParams = new URL(request.url).searchParams;

    if (path === '/health') {
      try {
        const health = store.health ? await store.health(index) : { ok: true };
        return json(request, 200, { provider: label, index, ...health });
      } catch (error) {
        return json(request, 503, {
          provider: label,
          index,
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    if (path !== '/rest/v1/app_state') {
      return json(request, 404, { error: 'ressource inconnue' });
    }

    if (searchParams.get('evict') === 'oldest') {
      const limit = Math.min(
        Math.max(Number.parseInt(searchParams.get('limit') || '', 10) || EVICT_BATCH, 1),
        2000
      );
      try {
        const evicted = await store.evict(index, limit);
        return json(request, 200, { evicted });
      } catch (error) {
        return json(request, 500, {
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    try {
      if (request.method === 'GET' || request.method === 'HEAD') {
        return await handleGet(store, index, request, searchParams);
      }
      if (['POST', 'PATCH', 'PUT'].includes(request.method)) {
        return await handlePut(store, index, request, searchParams);
      }
      if (request.method === 'DELETE') {
        return await handleDelete(store, index, request, searchParams);
      }
      return json(request, 405, { error: 'methode non supportee' });
    } catch (error) {
      if (error instanceof HttpError) {
        return pgrstError(request, error.status, error.code, error.message);
      }
      if (error instanceof QuotaError) {
        return pgrstError(request, 507, 'PGRST507', 'stockage plein');
      }
      console.error(`${label} app_state:`, error);
      return pgrstError(request, 500, 'PGRST500', 'erreur base de donnees');
    }
  };
}

export function quotaFromText(text) {
  return /quota|exceed|payment|restricted|insufficient|storage full|database full|max (?:size|storage|database|request)|spend cap|limit reached|limit exceeded|too many requests/i.test(
    String(text || '')
  );
}
