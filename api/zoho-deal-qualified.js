// api/zoho-deal-qualified.js — Vercel serverless function
// Receives the Zoho "Deal created by lead conversion" webhook and sends a qualified
// conversion (QualifiedShopifyLead / QualifiedFullStackLead) to the same Meta dataset
// as the landing-page Pixel and CAPI.
//
// The webhook supplies only the Deal ID. Everything else (service type, amount,
// contact details, attribution) is read back from Zoho with the server's own token.
//
// Duplicate prevention: a deterministic event_id ("zxq-<DealID>") plus a durable
// marker on the Deal itself, using Zoho tags (no custom field):
//   meta-qualified-pending  written BEFORE the Meta call; if it cannot be written,
//                           nothing is sent (proves the marker works on every run)
//   meta-qualified-sent     written only after Meta confirms events_received: 1;
//                           a Deal carrying it is never sent again
//
// Logs carry only: Deal ID, event name, result, HTTP status, events_received,
// fbtrace_id and a skip/failure reason. Never tokens, bodies or personal data.
//
// Zoho webhook URL: https://in.zyvextech.co/api/zoho-deal-qualified/ (trailing slash
// required: vercel.json has trailingSlash: true, so the bare path answers 308).
//
// Optional META_TEST_EVENT_CODE (Preview only, never Production): sent as
// test_event_code so the event appears under Events Manager > Test Events.

'use strict';

const crypto = require('crypto');

/* --- configuration ---------------------------------------------------------- */

const ZOHO_API     = 'https://www.zohoapis.in/crm/v2';
const ZOHO_ACCOUNTS = 'https://accounts.zoho.in/oauth/v2/token';
const META_API     = 'https://graph.facebook.com/v26.0';

const SECRET_HEADER  = 'x-zyvex-webhook-secret';
const MIN_SECRET_LEN = 32;

const TAG_PENDING = 'meta-qualified-pending';
const TAG_SENT    = 'meta-qualified-sent';

/** Meta only accepts website events up to 7 days old; keep a margin. */
const MAX_EVENT_AGE_MS = 7 * 24 * 60 * 60 * 1000 - 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;

/** Original Lead_Type on the converted Lead → qualified event. Anything else is skipped. */
const QUALIFIED_EVENTS = {
  'Shopify Builds':       { event: 'QualifiedShopifyLead',   content_name: 'shopify',              page: '/shopify/' },
  'Full Stack Marketing': { event: 'QualifiedFullStackLead', content_name: 'full_stack_marketing', page: '/' },
};

const RE_DEAL_ID = /^\d{10,25}$/;
const RE_TEST_EVENT_CODE = /^[\w-]{1,100}$/;
const RE_FBC     = /^fb\.[0-2]\.\d{13}\.[\w-]{10,500}$/;
const RE_FBP     = /^fb\.[0-2]\.\d{13}\.\d{5,30}$/;

/* --- helpers (same hashing and phone rules as api/submit-lead.js) ----------- */

function sha256(value) {
  if (!value) return undefined;
  return crypto
    .createHash('sha256')
    .update(String(value).trim().toLowerCase())
    .digest('hex');
}

function normalisePhone(raw) {
  if (!raw) return '';
  const stripped = String(raw).replace(/[^\d+]/g, '');
  return stripped.startsWith('+') ? stripped : '+' + stripped;
}

/** Constant-time comparison of the shared secret (digests have equal length). */
function secretMatches(given, expected) {
  if (typeof given !== 'string' || !given) return false;
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

function text(v) {
  return typeof v === 'string' && v.trim() ? v.trim() : '';
}

/** The only safe log line. Nothing personal or secret is ever passed in here. */
function logResult(fields) {
  const line = '[deal-qualified] ' + JSON.stringify(fields);
  if (fields.result === 'sent' || fields.result === 'duplicate' || fields.result === 'skipped') {
    console.info(line);
  } else {
    console.error(line);
  }
}

/** A failure that stops the run, with the HTTP status Zoho should see. */
class StopError extends Error {
  constructor(reason, status) {
    super(reason);
    this.reason = reason;
    this.status = status;
  }
}

async function timedFetch(url, opts) {
  const ctrl = new AbortController();
  const timer = setTimeout(function () { ctrl.abort(); }, FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, Object.assign({}, opts, { signal: ctrl.signal }));
  } finally {
    clearTimeout(timer);
  }
}

/** Read only deal_id from the webhook body (JSON object, JSON string or form-encoded). */
function readDealId(body) {
  let b = body;
  if (Buffer.isBuffer(b)) b = b.toString('utf8');
  if (typeof b === 'string') {
    try { b = JSON.parse(b); } catch (e) {
      try { b = Object.fromEntries(new URLSearchParams(b)); } catch (e2) { b = null; }
    }
  }
  if (!b || typeof b !== 'object') return '';
  const id = b.deal_id;
  const s = typeof id === 'number' ? String(id) : typeof id === 'string' ? id.trim() : '';
  return RE_DEAL_ID.test(s) ? s : '';
}

/* --- Zoho ------------------------------------------------------------------- */

async function getZohoAccessToken() {
  const params = new URLSearchParams({
    refresh_token: process.env.ZOHO_DEALS_REFRESH_TOKEN,
    client_id:     process.env.ZOHO_CLIENT_ID,
    client_secret: process.env.ZOHO_CLIENT_SECRET,
    grant_type:    'refresh_token',
  });
  let res;
  try {
    res = await timedFetch(ZOHO_ACCOUNTS + '?' + params.toString(), { method: 'POST' });
  } catch (e) {
    throw new StopError('zoho_unavailable', 503);
  }
  if (!res.ok) throw new StopError(res.status >= 500 ? 'zoho_unavailable' : 'zoho_auth_failed', 503);
  const json = await res.json().catch(function () { return null; });
  if (!json || json.error || !json.access_token) throw new StopError('zoho_auth_failed', 503);
  return json.access_token;
}

/**
 * Call the Zoho API. Returns parsed JSON, or null for 204 (no record / no rows).
 * Scope and auth problems stop the run before anything is sent to Meta.
 */
async function zoho(token, method, path, body) {
  let res;
  try {
    res = await timedFetch(ZOHO_API + path, {
      method: method,
      headers: Object.assign(
        { Authorization: 'Zoho-oauthtoken ' + token },
        body ? { 'Content-Type': 'application/json' } : {}
      ),
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new StopError('zoho_unavailable', 503);
  }
  if (res.status === 204) return null;
  const json = await res.json().catch(function () { return null; });
  if (res.ok) return json;

  const code = json && (json.code || (json.data && json.data[0] && json.data[0].code));
  if (code === 'OAUTH_SCOPE_MISMATCH' || code === 'NO_PERMISSION') throw new StopError('zoho_scope_missing', 503);
  if (res.status === 401) throw new StopError('zoho_auth_failed', 503);
  if (code === 'INVALID_DATA' || res.status === 404) return null;    // record does not exist
  throw new StopError('zoho_error_' + res.status, 503);
}

function firstRecord(json) {
  return json && Array.isArray(json.data) && json.data[0] ? json.data[0] : null;
}

function hasTag(record, name) {
  return Array.isArray(record.Tag) && record.Tag.some(function (t) { return t && t.name === name; });
}

/** Add or remove a tag on the Deal. Returns true only on a confirmed success. */
async function setTag(token, dealId, action, name) {
  try {
    const json = await zoho(
      token, 'POST',
      '/Deals/' + dealId + '/actions/' + action + '?tag_names=' + encodeURIComponent(name) + '&over_write=false'
    );
    const r = firstRecord(json);
    return !!r && r.status === 'success';
  } catch (e) {
    return false;
  }
}

/** The Lead this Deal was converted from (confirmed COQL pattern). */
async function findConvertedLead(token, dealId) {
  const json = await zoho(token, 'POST', '/coql', {
    select_query:
      'select id, Lead_Type, Lead_Source, Email, Mobile, Phone, Meta_FBC, Meta_FBP, ' +
      'Client_IP, User_Agent, Converted_Contact from Leads ' +
      'where Converted__s = true and Converted_Deal = ' + dealId + ' limit 2',
  });
  const rows = json && Array.isArray(json.data) ? json.data : [];
  if (rows.length > 1) throw new StopError('ambiguous_lead', 200);
  return rows[0] || null;
}

/* --- Meta CAPI -------------------------------------------------------------- */

function buildEvent(dealId, deal, lead, contact, mapping, eventTimeMs) {
  const email = text(contact && contact.Email) || text(lead.Email);
  const phone = text(contact && contact.Mobile) || text(contact && contact.Phone) ||
                text(lead.Mobile) || text(lead.Phone);
  const fbc = text(lead.Meta_FBC) || text(deal.Meta_FBC);
  const fbp = text(lead.Meta_FBP) || text(deal.Meta_FBP);
  const ip  = text(lead.Client_IP) || text(deal.Client_IP);
  const ua  = text(lead.User_Agent) || text(deal.User_Agent);

  const userData = {
    em: [sha256(email)].filter(Boolean),
    ph: [sha256(phone && normalisePhone(phone))].filter(Boolean),
  };
  if (ip) userData.client_ip_address = ip;
  if (ua) userData.client_user_agent = ua;
  // fbc / fbp only exactly as stored at form submission; malformed values are dropped, never rebuilt
  if (RE_FBC.test(fbc)) userData.fbc = fbc;
  if (RE_FBP.test(fbp)) userData.fbp = fbp;

  const customData = { content_name: mapping.content_name, currency: 'INR' };
  const amount = deal.Amount;
  const inr = !deal.Currency || deal.Currency === 'INR';
  if (inr && typeof amount === 'number' && isFinite(amount) && amount > 0) customData.value = amount;

  return {
    event_name:       mapping.event,
    event_time:       Math.floor(eventTimeMs / 1000),
    event_id:         'zxq-' + dealId,
    action_source:    'website',
    event_source_url: 'https://in.zyvextech.co' + mapping.page,
    user_data:        userData,
    custom_data:      customData,
  };
}

/** META_TEST_EVENT_CODE trimmed; '' when unset. A malformed value is reported as null. */
function testEventCode() {
  const raw = (process.env.META_TEST_EVENT_CODE || '').trim();
  if (!raw) return '';
  return RE_TEST_EVENT_CODE.test(raw) ? raw : null;
}

/** Returns { accepted, status, events_received, fbtrace_id, reason }. */
async function sendToMeta(event) {
  const pixelId = process.env.META_PIXEL_ID;
  const testCode = testEventCode();
  const payload = { data: [event], access_token: process.env.META_CAPI_TOKEN };
  if (testCode) payload.test_event_code = testCode;
  let res;
  try {
    res = await timedFetch(META_API + '/' + pixelId + '/events', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      // token in the body, not the URL, so it can't end up in any URL log
      body: JSON.stringify(payload),
    });
  } catch (e) {
    return { accepted: false, status: 0, reason: 'meta_unavailable' };
  }
  const json = await res.json().catch(function () { return null; }) || {};
  const out = {
    status: res.status,
    events_received: typeof json.events_received === 'number' ? json.events_received : undefined,
    fbtrace_id: json.fbtrace_id || (json.error && json.error.fbtrace_id) || undefined,
  };
  if (res.ok && json.events_received === 1) return Object.assign(out, { accepted: true });
  const err = json.error || {};
  out.meta_error_code = typeof err.code === 'number' ? err.code : undefined;
  out.meta_error_subcode = typeof err.error_subcode === 'number' ? err.error_subcode : undefined;
  out.reason = (res.status === 429 || res.status >= 500) ? 'meta_unavailable' : 'meta_rejected';
  return Object.assign(out, { accepted: false });
}

/* --- processing ------------------------------------------------------------- */

async function processDeal(dealId) {
  const token = await getZohoAccessToken();

  const deal = firstRecord(await zoho(token, 'GET', '/Deals/' + dealId));
  if (!deal) return { status: 200, result: 'skipped', reason: 'deal_not_found' };
  // Duplicate prevention depends on reading the Deal's tags; without them, send nothing.
  if (!Array.isArray(deal.Tag)) return { status: 503, result: 'failed', reason: 'tag_field_missing' };
  if (hasTag(deal, TAG_SENT)) return { status: 200, result: 'duplicate', reason: 'already_sent' };

  const contactId = deal.Contact_Name && deal.Contact_Name.id;
  const [lead, contactJson] = await Promise.all([
    findConvertedLead(token, dealId),
    RE_DEAL_ID.test(String(contactId || '')) ? zoho(token, 'GET', '/Contacts/' + contactId) : null,
  ]);
  if (!lead) return { status: 200, result: 'skipped', reason: 'no_converted_lead' };

  const mapping = Object.prototype.hasOwnProperty.call(QUALIFIED_EVENTS, lead.Lead_Type)
    ? QUALIFIED_EVENTS[lead.Lead_Type]
    : null;
  if (!mapping) return { status: 200, result: 'skipped', reason: 'unsupported_lead_type' };

  const created = Date.parse(deal.Created_Time);
  if (!isFinite(created)) return { status: 200, result: 'skipped', reason: 'no_deal_created_time', event: mapping.event };
  const now = Date.now();
  if (now - created > MAX_EVENT_AGE_MS) return { status: 200, result: 'skipped', reason: 'deal_too_old', event: mapping.event };
  const eventTime = Math.min(created, now);

  const event = buildEvent(dealId, deal, lead, firstRecord(contactJson), mapping, eventTime);
  if (!event.user_data.client_user_agent) {
    return { status: 200, result: 'skipped', reason: 'no_user_agent', event: mapping.event };
  }
  if (!event.user_data.em.length && !event.user_data.ph.length && !event.user_data.fbc && !event.user_data.fbp) {
    return { status: 200, result: 'skipped', reason: 'no_match_keys', event: mapping.event };
  }

  // Reserve first: if the marker can't be written, nothing goes to Meta.
  if (!(await setTag(token, dealId, 'add_tags', TAG_PENDING))) {
    return { status: 503, result: 'failed', reason: 'marker_unavailable', event: mapping.event };
  }

  const meta = await sendToMeta(event);
  const metaFields = {
    event: mapping.event,
    meta_status: meta.status,
    events_received: meta.events_received,
    fbtrace_id: meta.fbtrace_id,
  };

  if (!meta.accepted) {
    await setTag(token, dealId, 'remove_tags', TAG_PENDING);
    return Object.assign({
      status: meta.reason === 'meta_unavailable' ? 503 : 502,
      result: 'failed',
      reason: meta.reason,
      meta_error_code: meta.meta_error_code,
      meta_error_subcode: meta.meta_error_subcode,
    }, metaFields);
  }

  // Accepted by Meta: mark as sent. If that write fails, still answer 200 so Zoho
  // doesn't redeliver; a manual redelivery within 48 h is deduplicated by event_id.
  const marked = await setTag(token, dealId, 'add_tags', TAG_SENT);
  if (marked) await setTag(token, dealId, 'remove_tags', TAG_PENDING);
  return Object.assign({
    status: 200,
    result: marked ? 'sent' : 'sent_unmarked',
    reason: marked ? undefined : 'marker_write_failed',
  }, metaFields);
}

/* --- Vercel handler --------------------------------------------------------- */

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const secret = process.env.ZOHO_WEBHOOK_SECRET || '';
  const configured =
    secret.length >= MIN_SECRET_LEN &&
    process.env.ZOHO_DEALS_REFRESH_TOKEN && process.env.ZOHO_CLIENT_ID && process.env.ZOHO_CLIENT_SECRET &&
    process.env.META_PIXEL_ID && process.env.META_CAPI_TOKEN &&
    testEventCode() !== null;   // a malformed test code must never fall back to a real event
  if (!configured) {
    logResult({ result: 'failed', reason: 'not_configured' });
    return res.status(503).json({ ok: false, error: 'not_configured' });
  }

  const headers = req.headers || {};
  if (!secretMatches(headers[SECRET_HEADER], secret)) {
    logResult({ result: 'failed', reason: 'unauthorized' });
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  const dealId = readDealId(req.body);
  if (!dealId) {
    logResult({ result: 'failed', reason: 'invalid_deal_id' });
    return res.status(400).json({ ok: false, error: 'invalid_deal_id' });
  }

  let outcome;
  try {
    outcome = await processDeal(dealId);
  } catch (e) {
    outcome = e instanceof StopError
      ? { status: e.status, result: e.status === 200 ? 'skipped' : 'failed', reason: e.reason }
      : { status: 500, result: 'failed', reason: 'internal_error' };
  }

  const log = { deal_id: dealId };
  if (testEventCode()) log.test_event = true;
  ['event', 'result', 'reason', 'meta_status', 'events_received', 'fbtrace_id', 'meta_error_code', 'meta_error_subcode']
    .forEach(function (k) { if (outcome[k] !== undefined) log[k] = outcome[k]; });
  logResult(log);

  return res.status(outcome.status).json({
    ok: outcome.status === 200,
    result: outcome.result,
    ...(outcome.reason && { reason: outcome.reason }),
  });
};
