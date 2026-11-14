// Proxy de donnees avec bascule multi-cloud.
//
// Le client Supabase (cote app) peut pointer son URL de donnees vers
// `/api/db`. Chaque requete REST (`/rest/v1/...`) est alors envoyee aux
// fournisseurs configures dans `SUPABASE_PROJECTS`, dans l'ordre de priorite :
//   - lecture : agrégation avec bascule. On interroge les fournisseurs dans
//     l'ordre jusqu'a trouver les cles demandees. Un fournisseur vide ne
//     masque donc pas les donnees presentes chez un autre (utile quand une
//     base vient d'etre ajoutee) ;
//   - ecriture : envoi a tous les fournisseurs (double ecriture) pour garder
//     les copies synchronisees ; la premiere reponse reussie est renvoyee.
//   - si TOUTES les ecritures echouent (stockage plein), le proxy libere les
//     donnees les plus anciennes (images de messages/stories/publications) et
//     reessaie une fois.
//
// `SUPABASE_PROJECTS` (variable Cloudflare Pages) accepte une URL simple ou un
// tableau JSON d'objets :
//   ["https://xxxx.supabase.co","https://yyyy.supabase.co"]
//   [
//     {"name":"d1","url":"https://pro-num-tld.pages.dev/api/d1/0","priority":1},
//     {"name":"firebase","url":"https://pro-num-tld.pages.dev/api/firebase/0","priority":2},
//     {"name":"upstash","url":"https://pro-num-tld.pages.dev/api/upstash/0","priority":3},
//     {"name":"neon","url":"https://pro-num-tld.pages.dev/api/neon/0","priority":4},
//     {"name":"supabase","url":"https://xxxx.supabase.co","anonKey":"...","priority":5}
//   ]
//
// Auth, Realtime et Storage restent branches en direct sur le projet Supabase
// principal (voir src/lib/supabase.ts) : seul le trafic de donnees passe ici.

import {
  pickOldestDisposable,
  quotaFromText
} from '../../_lib/appStateStore.js';

const CAPACITOR_ORIGINS = new Set(['https://localhost', 'capacitor://localhost', 'http://localhost']);
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i;
const COOLDOWN_MS = 60_000;
const EVICT_BATCH = 200;
const EVICT_SCAN = 500;

function isAllowedOrigin(request) {
  const origin = request.headers.get('origin');
  if (!origin) return true;
  if (CAPACITOR_ORIGINS.has(origin)) return true;
  if (LOCAL_ORIGIN.test(origin)) return true;
  try {
    const originHost = new URL(origin).host;
    const requestHost = new URL(request.url).host;
    if (originHost === requestHost) return true;
    if (originHost.endsWith('.pages.dev') && requestHost.endsWith('pro-num-tld.pages.dev')) return true;
  } catch {
    return false;
  }
  return false;
}

function corsHeaders(request) {
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

function jsonResponse(request, status, payload, extraHeaders = {}) {
  return Response.json(payload, { status, headers: { ...corsHeaders(request), ...extraHeaders } });
}

function pgrstError(request, status, code, message) {
  return jsonResponse(request, status, { code, message, details: null, hint: null });
}

export async function onRequestOptions({ request }) {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}

let projectsCache = { raw: '', projects: [] };

function readProjects(env) {
  const raw = typeof env.SUPABASE_PROJECTS === 'string' ? env.SUPABASE_PROJECTS.trim() : '';
  const fallback = typeof env.SUPABASE_URL === 'string' ? env.SUPABASE_URL.trim() : '';
  const cacheKey = `${raw}|${fallback}`;
  if (projectsCache.raw === cacheKey) return projectsCache.projects;

  let list = [];
  if (raw) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.warn('SUPABASE_PROJECTS: JSON invalide');
      return [];
    }
    list = Array.isArray(parsed) ? parsed : [parsed];
  } else if (fallback) {
    // Repli : ancienne variable serveur deja utilisee par functions/api/push.js.
    list = [{ url: fallback }];
  }

  const projects = [];
  list.forEach((entry, index) => {
    const value = typeof entry === 'string' ? { url: entry } : entry;
    if (!value || typeof value.url !== 'string' || !value.url || value.enabled === false) return;
    let url;
    try {
      url = new URL(value.url).toString().replace(/\/+$/, '');
    } catch {
      return;
    }
    const name = typeof value.name === 'string' && value.name ? value.name : url;
    const priority = Number.isFinite(Number(value.priority)) ? Number(value.priority) : 1000 + index;
    projects.push({
      name,
      url,
      anonKey: typeof value.anonKey === 'string' ? value.anonKey : '',
      priority,
      order: index
    });
  });

  projects.sort((a, b) => a.priority - b.priority || a.order - b.order);
  projectsCache = { raw: cacheKey, projects };
  return projects;
}

// Etat de sante par fournisseur (par isolat Cloudflare). Un fournisseur en
// echec est mis en quarantaine 60 s pour ne pas ralentir chaque requete.
const providerHealth = new Map();

function recordFailure(project, message, full, unreachable = false) {
  const entry = providerHealth.get(project.url) || { failures: 0 };
  entry.failures += 1;
  entry.lastError = message;
  entry.full = Boolean(full);
  entry.unreachable = Boolean(unreachable);
  entry.cooldownUntil = Date.now() + COOLDOWN_MS;
  providerHealth.set(project.url, entry);
  console.warn(`Proxy donnees: ${project.name} → ${message}`);
}

function recordSuccess(project) {
  if (providerHealth.delete(project.url)) {
    console.info(`Proxy donnees: ${project.name} → retabli`);
  }
}

function orderProjects(projects) {
  const now = Date.now();
  const healthy = [];
  const cooling = [];
  for (const project of projects) {
    const health = providerHealth.get(project.url);
    if (health && health.cooldownUntil > now) cooling.push(project);
    else healthy.push(project);
  }
  return [...healthy, ...cooling];
}

// Pour les ecritures, un fournisseur injoignable en quarantaine est ecarte :
// sinon chaque ecriture attendrait son timeout. Les fournisseurs qui repondent
// mais renvoient une erreur (quota, auth...) restent essayes : ils peuvent
// redevenir disponibles a tout moment.
function writeTargets(projects) {
  const now = Date.now();
  const usable = projects.filter((project) => {
    const health = providerHealth.get(project.url);
    if (!health || health.cooldownUntil <= now) return true;
    return !health.unreachable;
  });
  return usable.length > 0 ? usable : projects;
}

function isAdapterUrl(url) {
  return /\/api\/(firebase|upstash|d1|neon)(\/|$)/.test(url);
}

function authHeaders(project, clientApikey) {
  const headers = new Headers();
  const key = project.anonKey || clientApikey || '';
  if (key) {
    headers.set('apikey', key);
    headers.set('authorization', `Bearer ${key}`);
  }
  return headers;
}

function buildHeaders(request, project) {
  const headers = new Headers();
  const clientApikey = request.headers.get('apikey') || '';
  for (const [name, value] of request.headers) {
    const lower = name.toLowerCase();
    if (
      lower === 'host' ||
      lower === 'content-length' ||
      lower === 'connection' ||
      lower === 'upgrade' ||
      lower === 'origin' ||
      lower === 'cf-connecting-ip' ||
      lower === 'cf-ray' ||
      lower.startsWith('x-forwarded-') ||
      lower.startsWith('cf-')
    ) {
      continue;
    }
    headers.set(name, value);
  }
  const key = project.anonKey || clientApikey;
  if (key) {
    headers.set('apikey', key);
    const authorization = headers.get('authorization');
    if (!authorization || (clientApikey && authorization === `Bearer ${clientApikey}`)) {
      headers.set('authorization', `Bearer ${key}`);
    }
  }
  return headers;
}

async function forward(project, request, path, search, body, timeoutMs = 20_000) {
  const target = `${project.url}${path}${search}`;
  const init = {
    method: request.method,
    headers: buildHeaders(request, project),
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs)
  };
  if (body !== undefined) init.body = body;
  return fetch(target, init);
}

function cleanResponse(response, request) {
  const headers = new Headers();
  const blocked = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection']);
  for (const [name, value] of response.headers) {
    if (!blocked.has(name.toLowerCase())) headers.set(name, value);
  }
  for (const [name, value] of Object.entries(corsHeaders(request))) {
    headers.set(name, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

async function inspectResponse(response) {
  const status = response.status;
  let text = '';
  if (!response.ok) {
    try {
      text = await response.clone().text();
    } catch {
      /* corps illisible */
    }
  }
  text = text.slice(0, 1200);
  // PostgREST renvoie 406/PGRST116 quand `.maybeSingle()` ne trouve aucune
  // ligne : ce n'est pas une panne, simplement une cle absente du fournisseur.
  const noRows = status === 406 && /PGRST116/.test(text);
  const full = !noRows && (status === 402 || status === 507 || quotaFromText(text));
  const retryable =
    !noRows &&
    (status === 401 ||
      status === 402 ||
      status === 403 ||
      status === 429 ||
      status === 507 ||
      status >= 500);
  return { status, text, noRows, full, retryable };
}

function isSingleAccept(request) {
  return (request.headers.get('accept') || '').includes('vnd.pgrst.object+json');
}

function readKeyFilter(search) {
  const params = new URLSearchParams(search);
  const filter = params.get('key');
  if (!filter) return { eq: null, inList: null };
  if (filter.startsWith('eq.')) return { eq: filter.slice(3), inList: null };
  if (filter.startsWith('in.(') && filter.endsWith(')')) {
    const inner = filter.slice(4, -1).trim();
    const inList = inner
      ? inner
          .split(',')
          .map((part) => part.trim().replace(/^"(.*)"$/, '$1'))
          .filter(Boolean)
      : [];
    return { eq: null, inList };
  }
  return { eq: null, inList: null };
}

async function readOne(projects, request, path, search, select, single) {
  for (const project of projects) {
    let response;
    try {
      response = await forward(project, request, path, search);
    } catch {
      recordFailure(project, 'injoignable', false, true);
      continue;
    }
    const info = await inspectResponse(response);
    if (info.noRows) {
      recordSuccess(project);
      continue;
    }
    if (info.retryable || !response.ok) {
      recordFailure(project, info.text || `HTTP ${response.status}`, info.full);
      continue;
    }
    let parsed = null;
    try {
      parsed = await response.json();
    } catch {
      parsed = null;
    }
    recordSuccess(project);
    const rows = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
    if (rows.length === 0) continue;
    if (single) return jsonResponse(request, 200, rows[0]);
    return jsonResponse(request, 200, rows, {
      'content-range': `0-${Math.max(rows.length - 1, 0)}/${rows.length}`
    });
  }
  if (single) {
    return pgrstError(request, 406, 'PGRST116', 'JSON object requested, multiple (or no) rows returned');
  }
  return jsonResponse(request, 200, [], { 'content-range': '0--1/0' });
}

async function readMany(projects, request, path, keys, select, single) {
  const wanted = new Set(keys);
  const found = new Map();
  for (const project of projects) {
    const remaining = keys.filter((key) => !found.has(key));
    if (remaining.length === 0) break;
    const params = new URLSearchParams();
    params.set('select', select);
    params.set('key', `in.(${remaining.join(',')})`);
    let response;
    try {
      response = await forward(project, request, path, `?${params.toString()}`);
    } catch {
      recordFailure(project, 'injoignable', false, true);
      continue;
    }
    const info = await inspectResponse(response);
    if (info.retryable || !response.ok) {
      recordFailure(project, info.text || `HTTP ${response.status}`, info.full);
      continue;
    }
    let rows = [];
    try {
      const body = await response.json();
      rows = Array.isArray(body) ? body : body ? [body] : [];
    } catch {
      rows = [];
    }
    rows.forEach((row) => {
      if (row && typeof row.key === 'string' && wanted.has(row.key) && !found.has(row.key)) {
        found.set(row.key, row);
      }
    });
    recordSuccess(project);
  }
  const rows = keys.map((key) => found.get(key)).filter(Boolean);
  if (single) {
    if (rows.length !== 1) {
      return pgrstError(request, 406, 'PGRST116', 'JSON object requested, multiple (or no) rows returned');
    }
    return jsonResponse(request, 200, rows[0]);
  }
  return jsonResponse(request, 200, rows, {
    'content-range': `0-${Math.max(rows.length - 1, 0)}/${rows.length}`
  });
}

async function readList(projects, request, path, search, single) {
  for (const project of projects) {
    let response;
    try {
      response = await forward(project, request, path, search);
    } catch {
      recordFailure(project, 'injoignable', false, true);
      continue;
    }
    const info = await inspectResponse(response);
    if (info.noRows) {
      recordSuccess(project);
      continue;
    }
    if (info.retryable || !response.ok) {
      recordFailure(project, info.text || `HTTP ${response.status}`, info.full);
      continue;
    }
    let parsed = null;
    try {
      parsed = await response.json();
    } catch {
      parsed = null;
    }
    recordSuccess(project);
    const rows = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
    if (rows.length === 0) continue;
    if (single) {
      if (rows.length !== 1) {
        return pgrstError(request, 406, 'PGRST116', 'JSON object requested, multiple (or no) rows returned');
      }
      return jsonResponse(request, 200, rows[0]);
    }
    return jsonResponse(request, 200, rows, {
      'content-range': `0-${Math.max(rows.length - 1, 0)}/${rows.length}`
    });
  }
  if (single) {
    return pgrstError(request, 406, 'PGRST116', 'JSON object requested, multiple (or no) rows returned');
  }
  return jsonResponse(request, 200, [], { 'content-range': '0--1/0' });
}

async function readWithFailover(projects, request, path, search) {
  const ordered = orderProjects(projects);
  const params = new URLSearchParams(search);
  const select = params.get('select') || '*';
  const single = isSingleAccept(request);
  const { eq, inList } = readKeyFilter(search);

  if (eq !== null) return readOne(ordered, request, path, search, select, single);
  if (inList !== null) return readMany(ordered, request, path, inList, select, single);
  return readList(ordered, request, path, search, single);
}

async function evictProvider(project, request) {
  const clientApikey = request.headers.get('apikey') || '';
  try {
    if (isAdapterUrl(project.url)) {
      const response = await fetch(
        `${project.url}/rest/v1/app_state?evict=oldest&limit=${EVICT_BATCH}`,
        {
          method: 'POST',
          headers: authHeaders(project, clientApikey),
          signal: AbortSignal.timeout(15_000)
        }
      );
      if (!response.ok) return 0;
      const body = await response.json().catch(() => null);
      return body && Number(body.evicted) ? Number(body.evicted) : 0;
    }

    // Projet Supabase direct : on liste les lignes les plus anciennes puis on
    // supprime uniquement les images jetables.
    const listResponse = await fetch(
      `${project.url}/rest/v1/app_state?select=key,updated_at&order=updated_at.asc&limit=${EVICT_SCAN}`,
      { headers: authHeaders(project, clientApikey), signal: AbortSignal.timeout(15_000) }
    );
    if (!listResponse.ok) return 0;
    const rows = await listResponse.json().catch(() => []);
    const victims = pickOldestDisposable(Array.isArray(rows) ? rows : [], EVICT_BATCH);
    let evicted = 0;
    for (const victim of victims) {
      const headers = authHeaders(project, clientApikey);
      headers.set('prefer', 'return=minimal');
      const response = await fetch(
        `${project.url}/rest/v1/app_state?key=eq.${encodeURIComponent(victim.key)}`,
        { method: 'DELETE', headers, signal: AbortSignal.timeout(15_000) }
      );
      if (response.ok) evicted += 1;
    }
    return evicted;
  } catch {
    return 0;
  }
}

async function writeWithReplication(projects, request, path, search, body) {
  const full = new Map();
  const attempt = async (list) => {
    const settled = await Promise.allSettled(
      list.map((project) => forward(project, request, path, search, body, 8_000))
    );
    let success = null;
    let firstError = null;
    for (let i = 0; i < settled.length; i += 1) {
      const project = list[i];
      const result = settled[i];
      if (result.status === 'rejected') {
        recordFailure(project, 'injoignable', false, true);
        continue;
      }
      const response = result.value;
      if (response.ok) {
        recordSuccess(project);
        if (!success) success = response;
        else void response.body?.cancel();
        continue;
      }
      const info = await inspectResponse(response);
      recordFailure(project, info.text || `HTTP ${response.status}`, info.full);
      if (info.full) full.set(project.url, project);
      if (!firstError) firstError = response;
      else void response.body?.cancel();
    }
    return { success, firstError };
  };

  let { success, firstError } = await attempt(writeTargets(projects));
  if (success) return success;

  // Uniquement si un fournisseur signale un quota plein : liberer les donnees
  // les plus anciennes, puis reessayer une fois. Une simple panne reseau ne
  // doit pas declencher de suppression.
  if (full.size === 0) return firstError;

  console.warn('Proxy donnees: quota atteint, liberation des elements les plus anciens');
  if (firstError) void firstError.body?.cancel();
  await Promise.allSettled(
    [...full.values()].map((project) => evictProvider(project, request))
  );
  ({ success, firstError } = await attempt(projects));
  return success || firstError;
}

async function headWithFailover(projects, request, path, search) {
  for (const project of orderProjects(projects)) {
    let response;
    try {
      response = await forward(project, request, path, search);
    } catch {
      recordFailure(project, 'injoignable', false, true);
      continue;
    }
    const info = await inspectResponse(response);
    if (info.retryable || !response.ok) {
      recordFailure(project, info.text || `HTTP ${response.status}`, info.full);
      void response.body?.cancel();
      continue;
    }
    recordSuccess(project);
    return cleanResponse(response, request);
  }
  return new Response(null, {
    status: 200,
    headers: { ...corsHeaders(request), 'content-range': '0--1/0' }
  });
}

export async function onRequest(context) {
  const { request, env, params } = context;
  if (!isAllowedOrigin(request)) {
    return jsonResponse(request, 403, { error: 'origine refusee' });
  }

  const projects = readProjects(env);
  if (projects.length === 0) {
    return jsonResponse(request, 503, { error: 'aucune base configuree' });
  }

  const segments = Array.isArray(params.path) ? params.path : params.path ? [params.path] : [];
  const path = `/${segments.join('/')}`;
  const url = new URL(request.url);
  const search = url.search;

  if (path === '/health' || path === '/') {
    const now = Date.now();
    const providers = projects.map((project) => {
      const health = providerHealth.get(project.url);
      return {
        name: project.name,
        url: project.url,
        priority: project.priority,
        cooldownMs: health ? Math.max(0, (health.cooldownUntil || 0) - now) : 0,
        full: Boolean(health && health.full),
        unreachable: Boolean(health && health.unreachable),
        lastError: (health && health.lastError) || null
      };
    });
    const ok = providers.some((provider) => provider.cooldownMs === 0 && !provider.full);
    return jsonResponse(request, 200, { ok, count: providers.length, providers });
  }

  if (request.method === 'HEAD') {
    return headWithFailover(projects, request, path, search);
  }

  if (request.method === 'GET') {
    return readWithFailover(projects, request, path, search);
  }

  const body = await request.arrayBuffer();
  const response = await writeWithReplication(projects, request, path, search, body);
  if (!response) return jsonResponse(request, 502, { error: 'bases injoignables' });
  return cleanResponse(response, request);
}
