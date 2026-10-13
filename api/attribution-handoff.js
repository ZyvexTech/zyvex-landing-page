// api/attribution-handoff.js — Vercel serverless function
// Cross-browser Meta click handoff (assets/attribution.js, zx_hid carrier).
//
// An in-app browser (Instagram/Facebook WebView) that landed from a Meta ad registers its
// click under a random 256-bit handle (zx_hid) and puts that handle in its address bar.
// If the visitor then opens the page in Chrome/Safari and the handle survives, that browser
// retrieves the original click once and continues the same Meta journey.
//
//   POST /api/attribution-handoff/  {"action":"register","hid":"…","fbclid":"…","fbc":"…","ts":…,"u":{…}}
//     200 {ok:true}                     stored (or an identical record was already stored: retry-safe)
//     409 {ok:false,error:"conflict"}   the handle already holds a different click
//   POST /api/attribution-handoff/  {"action":"retrieve","hid":"…"}
//     200 {ok:true,fbclid,fbc,ts,u}     the record, deleted in the same operation (one-time)
//     404 {ok:false,error:"not_found"}  missing, expired or already retrieved
//   400 invalid input · 403 origin not allowed · 405 method · 413 body too large
//   503 storage unavailable (or not configured)
//
// Storage: Upstash Redis REST (UPSTASH_KV_REST_API_URL / UPSTASH_KV_REST_API_TOKEN).
//   register  SET key value NX EX 300   never overwrites; 5-minute TTL fixed at registration
//   retrieve  GETDEL key                atomic read-and-delete; never touches the TTL
// The Redis key is a SHA-256 of the handle, so stored keys cannot be used as handles.
// Records hold only the click (fbclid, fbc, click/journey time, UTMs): no PII, no fbp.
// Nothing here talks to Meta; the lead form's existing CAPI path sends conversions.
// Logs never contain a handle, fbclid, fbc or the token.

'use strict';

const crypto = require('crypto');

const TTL_SECONDS   = 300;                    // 5 minutes from registration
const CLICK_MAX_MS  = 60 * 60 * 1000;         // matches attribution.js: a Meta journey lasts 1 hour
const CLOCK_SKEW_MS = 5 * 60 * 1000;          // tolerated client clock drift
const MAX_BODY      = 4096;                   // bytes
const KEY_PREFIX    = 'zx:hid:';

const RE_HID      = /^[A-Za-z0-9_-]{43}$/;     // 32 random bytes, Base64URL without padding
const RE_CLICK_ID = /^[\w-]{10,500}$/;         // same rules as attribution.js
const RE_FBC      = /^fb\.[0-2]\.\d{13}\.[\w-]{10,500}$/;
const UTM_KEYS    = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'utm_id'];

function fbcTime(v)    { return Number(v.split('.')[2]); }
function fbcClickId(v) { return v.split('.').slice(3).join('.'); }

function isAllowedOrigin(origin) {
  return origin === 'https://in.zyvextech.co' ||
    /^https:\/\/[a-z0-9-]+\.zyvextech\.co$/.test(origin) ||
    /^https:\/\/zyvextech-in-v4[a-z0-9-]*\.vercel\.app$/.test(origin) ||
    /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin);
}

function redisKey(hid) {
  return KEY_PREFIX + crypto.createHash('sha256').update(hid).digest('base64url');
}

// Validates a click (fbclid + fbc + journey start time) the way attribution.js does, and
// requires it to be recent: the receiving browser can only use a click under 1 hour old.
// Returns the normalized record or null.
function validClick(input, now) {
  if (!input || typeof input !== 'object') return null;
  const { fbclid, fbc, ts } = input;
  if (typeof fbclid !== 'string' || !RE_CLICK_ID.test(fbclid)) return null;
  if (typeof fbc !== 'string' || !RE_FBC.test(fbc)) return null;
  if (fbcClickId(fbc) !== fbclid) return null;                 // fbc and fbclid must be the same click
  if (typeof ts !== 'number' || !Number.isSafeInteger(ts)) return null;
  const clickTs = fbcTime(fbc);
  if (clickTs > now + CLOCK_SKEW_MS || now - clickTs >= CLICK_MAX_MS) return null;
  if (ts > now + CLOCK_SKEW_MS || now - ts >= CLICK_MAX_MS) return null;
  if (ts + CLOCK_SKEW_MS < clickTs) return null;               // journey cannot start before its click
  const u = {};
  if (input.u !== undefined) {
    if (!input.u || typeof input.u !== 'object' || Array.isArray(input.u)) return null;
    for (const k of Object.keys(input.u)) {
      const v = input.u[k];
      if (!UTM_KEYS.includes(k) || typeof v !== 'string') return null;
      const clean = v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 200);
      if (clean) u[k] = clean;
    }
  }
  return { fbclid, fbc, ts, u };
}

async function redis(command) {
  const url = process.env.UPSTASH_KV_REST_API_URL;
  const token = process.env.UPSTASH_KV_REST_API_TOKEN;
  if (!url || !token) {
    const err = new Error('storage not configured');
    err.code = 'not_configured';
    throw err;
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
    signal: AbortSignal.timeout(4000),
  });
  let json = null;
  try { json = await res.json(); } catch (e) { /* non-JSON */ }
  if (!res.ok || !json || json.error) {
    const err = new Error('storage error');
    err.code = 'storage_error';
    err.status = res.status;
    throw err;
  }
  return json.result;
}

function storageFailure(res, action, err) {
  console.error('[handoff] storage unavailable', JSON.stringify({
    action, code: err.code || 'network', status: err.status || null,
  }));
  return res.status(503).json({ ok: false, error: 'storage_unavailable' });
}

async function register(body, res, now) {
  const click = validClick(body, now);
  if (!click) return res.status(400).json({ ok: false, error: 'invalid_click' });
  const record = JSON.stringify({ v: 1, fbclid: click.fbclid, fbc: click.fbc, ts: click.ts, u: click.u, at: now });
  const key = redisKey(body.hid);
  try {
    const set = await redis(['SET', key, record, 'NX', 'EX', String(TTL_SECONDS)]);
    if (set === 'OK') {
      console.info('[handoff] registered');
      return res.status(200).json({ ok: true, ttl: TTL_SECONDS });
    }
    // The handle exists. A retry of the same registration is fine; anything else is refused.
    // GET does not change the TTL.
    const existing = await redis(['GET', key]);
    let prev = null;
    try { prev = existing ? JSON.parse(existing) : null; } catch (e) { /* corrupt */ }
    if (prev && prev.fbclid === click.fbclid && prev.fbc === click.fbc && prev.ts === click.ts) {
      return res.status(200).json({ ok: true, ttl: TTL_SECONDS, duplicate: true });
    }
    console.warn('[handoff] register conflict');
    return res.status(409).json({ ok: false, error: 'conflict' });
  } catch (err) {
    return storageFailure(res, 'register', err);
  }
}

async function retrieve(body, res, now) {
  let raw;
  try {
    raw = await redis(['GETDEL', redisKey(body.hid)]);
  } catch (err) {
    return storageFailure(res, 'retrieve', err);
  }
  let rec = null;
  try { rec = raw ? JSON.parse(raw) : null; } catch (e) { /* corrupt */ }
  // Re-check what was stored: within the 5-minute window and still a valid, recent click.
  const click = rec && typeof rec.at === 'number' && now - rec.at < TTL_SECONDS * 1000
    ? validClick(rec, now)
    : null;
  if (!click) {
    console.info('[handoff] retrieve miss');
    return res.status(404).json({ ok: false, error: 'not_found' });
  }
  console.info('[handoff] retrieved');
  return res.status(200).json({ ok: true, fbclid: click.fbclid, fbc: click.fbc, ts: click.ts, u: click.u });
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  const origin = req.headers.origin || '';
  if (!isAllowedOrigin(origin)) return res.status(403).json({ ok: false, error: 'forbidden' });
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');

  const len = Number(req.headers['content-length'] || 0);
  if (len > MAX_BODY) return res.status(413).json({ ok: false, error: 'too_large' });

  let body = req.body;
  try {
    if (typeof body === 'string') {
      if (body.length > MAX_BODY) return res.status(413).json({ ok: false, error: 'too_large' });
      body = JSON.parse(body);
    }
  } catch (e) {
    return res.status(400).json({ ok: false, error: 'invalid_json' });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return res.status(400).json({ ok: false, error: 'invalid_body' });
  }
  if (JSON.stringify(body).length > MAX_BODY) return res.status(413).json({ ok: false, error: 'too_large' });
  if (typeof body.hid !== 'string' || !RE_HID.test(body.hid)) {
    return res.status(400).json({ ok: false, error: 'invalid_hid' });
  }

  const now = Date.now();
  if (body.action === 'register') return register(body, res, now);
  if (body.action === 'retrieve') return retrieve(body, res, now);
  return res.status(400).json({ ok: false, error: 'invalid_action' });
};

module.exports._internal = { validClick, redisKey, isAllowedOrigin, TTL_SECONDS };
