// api/submit-lead.js — Vercel serverless function
// Handles: Meta CAPI (server-side Lead event) + Zoho CRM lead creation.
// No credentials are returned to the browser; all secrets live in env vars.

'use strict';

const crypto = require('crypto');

/* --- helpers ---------------------------------------------------------------- */

/** SHA-256 hex digest of a normalised string (lowercase, trimmed). */
function sha256(value) {
  if (!value) return undefined;
  return crypto
    .createHash('sha256')
    .update(String(value).trim().toLowerCase())
    .digest('hex');
}

/** Normalise a phone number to E.164: strip non-digits, ensure leading +. */
function normalisePhone(raw) {
  if (!raw) return '';
  const stripped = String(raw).replace(/[^\d+]/g, '');
  return stripped.startsWith('+') ? stripped : '+' + stripped;
}

/* --- Attribution (browser-supplied, untrusted) ------------------------------ */

const RE_CLICK_ID = /^[\w-]{10,500}$/;
const RE_FBC      = /^fb\.[0-2]\.\d{13}\.[\w-]{10,500}$/;
const RE_FBP      = /^fb\.[0-2]\.\d{13}\.\d{5,30}$/;

/** An active Meta journey lasts 1 hour from the click (same limit as attribution.js). */
const META_JOURNEY_MAX_MS = 60 * 60 * 1000;

function cleanText(v) {
  if (typeof v !== 'string') return '';
  return v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 200);
}

/**
 * Validate the attribution object sent by the browser. Malformed values are
 * dropped (never repaired), so they reach neither Meta nor Zoho, and a bad
 * value never blocks the lead itself.
 *
 * fbc: a valid browser value (Meta's _fbc, or one stamped with the time the
 * fbclid was first captured) is used as-is. Only when there is none is it
 * built from a valid fbclid, which is the previous behaviour.
 */
function normaliseAttribution(raw) {
  const a = raw && typeof raw === 'object' ? raw : {};
  let fbclid = typeof a.fbclid === 'string' && RE_CLICK_ID.test(a.fbclid) ? a.fbclid : '';
  let browserFbc = typeof a.fbc === 'string' && RE_FBC.test(a.fbc) ? a.fbc : '';
  // Active Meta journey: the browser's explicit signal (zx_mj), under 1 hour old, with a
  // valid click identifier. Without it fbc/fbclid are not current attribution, so they are
  // dropped here (never repaired or rebuilt) and reach neither Meta CAPI nor Zoho.
  const mj = a.meta_journey && typeof a.meta_journey === 'object' ? a.meta_journey : null;
  const metaJourney = !!mj && mj.source === 'meta' &&
    typeof mj.age_ms === 'number' && isFinite(mj.age_ms) &&
    mj.age_ms >= 0 && mj.age_ms < META_JOURNEY_MAX_MS &&
    !!(fbclid || browserFbc);
  if (!metaJourney) { fbclid = ''; browserFbc = ''; }
  // Consistency: never send an fbclid and fbc that describe different clicks.
  // The selected fbc wins; a mismatched fbclid is discarded (the lead is not blocked).
  if (browserFbc && fbclid && browserFbc.split('.').slice(3).join('.') !== fbclid) fbclid = '';
  const fbc =
    browserFbc ? browserFbc
    : fbclid ? `fb.1.${Date.now()}.${fbclid}`
    : '';
  // gclid: same format as fbclid but only kept when genuinely present; never fabricated.
  const gclid = typeof a.gclid === 'string' && RE_CLICK_ID.test(a.gclid) ? a.gclid : '';
  return {
    utm_source:   cleanText(a.utm_source),
    utm_medium:   cleanText(a.utm_medium),
    utm_campaign: cleanText(a.utm_campaign),
    utm_content:  cleanText(a.utm_content),
    utm_term:     cleanText(a.utm_term),
    utm_id:       cleanText(a.utm_id),
    gclid:        gclid,
    fbclid:       fbclid,
    fbc:          fbc,
    meta_journey: metaJourney,
    fbp:          typeof a.fbp === 'string' && RE_FBP.test(a.fbp) ? a.fbp : '',
    ...(a.first_touch && typeof a.first_touch === 'object' && { first_touch: a.first_touch }),
    ...(a.latest_touch && typeof a.latest_touch === 'object' && { latest_touch: a.latest_touch }),
  };
}

/* --- Zoho Lead_Source ------------------------------------------------------- */

/**
 * Lead_Source (Zoho picklist display value) for a website lead. Exactly two outcomes:
 *   "Meta Ads"  an active Meta journey (zx_mj) is present
 *   "Direct"    anything else
 * The journey is the only authority. An fbc / fbclid on its own, however valid or recent,
 * never makes a lead "Meta Ads", and neither do UTMs, gclid or the first_touch /
 * latest_touch history. Takes the output of normaliseAttribution(). Pure.
 */
function getLeadSource(attribution) {
  return attribution && attribution.meta_journey === true ? 'Meta Ads' : 'Direct';
}

/* --- Meta CAPI -------------------------------------------------------------- */

/**
 * Fire a server-side "Lead" event to the Meta Conversions API.
 * https://developers.facebook.com/docs/marketing-api/conversions-api
 */
async function sendMetaCapi(payload, req) {
  const pixelId   = process.env.META_PIXEL_ID;
  const capiToken = process.env.META_CAPI_TOKEN;

  if (!pixelId || !capiToken) {
    console.warn('[CAPI] META_PIXEL_ID or META_CAPI_TOKEN not set -- skipping');
    return;
  }

  const { service, event_id, budget_tier, attribution = {} } = payload;

  const eventName = service === 'shopify'
    ? 'ShopifyLead'
    : 'FullStackLead';

  const clientIp = (
    req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || ''
  ).split(',')[0].trim();

  const userAgent = req.headers['user-agent'] || '';

  const fbc = attribution.fbc || undefined;

  const userData = {
    em: [sha256(payload.email)].filter(Boolean),
    ph: [sha256(normalisePhone(payload.phone))].filter(Boolean),
  };
  if (clientIp)  userData.client_ip_address  = clientIp;
  if (userAgent) userData.client_user_agent  = userAgent;
  if (fbc)       userData.fbc                = fbc;
  if (attribution.fbp) userData.fbp          = attribution.fbp;

  const eventPayload = {
    data: [
      {
        event_name:       eventName,
        event_time:       Math.floor(Date.now() / 1000),
        event_id:         event_id,
        action_source:    'website',
        event_source_url: 'https://in.zyvextech.co' + (payload.page || '/'),
        user_data:        userData,
        custom_data: {
          content_name: service || payload.form || 'unknown',
          ...(CAPI_VALUE_MAP[budget_tier] !== undefined && { value: CAPI_VALUE_MAP[budget_tier] }),
          currency:     'INR',
        },
      },
    ],
  };

  const url =
    'https://graph.facebook.com/v26.0/' +
    pixelId +
    '/events?access_token=' +
    capiToken;

  const res = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(eventPayload),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error('[CAPI] Graph API error:', res.status, text);
  } else {
    const json = await res.json();
    console.info('[CAPI] Success:', JSON.stringify(json));
  }
}

/* --- Zoho CRM --------------------------------------------------------------- */

/** Exchange the stored refresh token for a short-lived access token. */
async function getZohoAccessToken() {
  const params = new URLSearchParams({
    refresh_token: process.env.ZOHO_REFRESH_TOKEN,
    client_id:     process.env.ZOHO_CLIENT_ID,
    client_secret: process.env.ZOHO_CLIENT_SECRET,
    grant_type:    'refresh_token',
  });

  const res = await fetch(
    'https://accounts.zoho.in/oauth/v2/token?' + params.toString(),
    { method: 'POST' }
  );

  if (!res.ok) {
    throw new Error('[Zoho] Token refresh failed: HTTP ' + res.status);
  }

  const json = await res.json();
  if (json.error) throw new Error('[Zoho] Token refresh error: ' + json.error);

  return json.access_token;
}

/** Max length of Zoho single-line text fields (User_Agent, Client_IP, Meta_*, Timeline). */
const ZOHO_TEXT_MAX = 255;

/** Maps the frontend `service` value to the Zoho Lead_Type picklist label. */
const LEAD_TYPE_MAP = {
  full_stack_marketing: 'Full Stack Marketing',
  shopify:             'Shopify Builds',
};

const BUDGET_MAP = {
  '25k-50k': '25K - 50K',
  '50k-1l': '50K - 1L',
  '1l-3l': '1L - 3L',
  '3l-5l': '3L - 5L',
  '1l-5l': '1L - 5L',
  '5l-20l': '5L - 20L',
  '20l-plus': '20L +',
};

/**
 * Server-side CAPI value lookup keyed by budget_tier (INR).
 * Never trusts the browser-supplied lead_value; only these known tiers are accepted.
 * If budget_tier is absent or unrecognised, value is omitted from custom_data entirely.
 */
const CAPI_VALUE_MAP = {
  '25k-50k':  25000,
  '50k-1l':   50000,
  '1l-3l':   100000,
  '3l-5l':   300000,
  '1l-5l':   100000,
  '5l-20l':  300000,
  '20l-plus': 300000,
};

/**
 * Create a Lead record in Zoho CRM (Leads module).
 * Required env vars: ZOHO_REFRESH_TOKEN, ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET.
 */
async function createZohoLead(payload, req) {
  if (
    !process.env.ZOHO_REFRESH_TOKEN ||
    !process.env.ZOHO_CLIENT_ID     ||
    !process.env.ZOHO_CLIENT_SECRET
  ) {
    console.warn('[Zoho] Credentials not configured -- skipping CRM write');
    return;
  }

  const {
    name, email, phone, business, website,
    budget, budget_tier, budget_label, message, service,
    timeline,
    attribution = {},
  } = payload;

  const accessToken = await getZohoAccessToken();

  // Split full name into first / last (Zoho requires at least Last_Name)
  const parts    = (name || '').trim().split(/\s+/);
  const lastName  = parts.length > 1 ? parts.slice(1).join(' ') : (parts[0] || 'Unknown');
  const firstName = parts.length > 1 ? parts[0] : '';

  // Extract client IP, user agent, and fbc using existing logic
  const clientIp = (
    payload.client_ip ||
    (req && req.headers && (req.headers['x-forwarded-for'] || req.headers['x-real-ip']) || '')
  ).split(',')[0].trim();

  const userAgent = payload.user_agent || (req && req.headers && req.headers['user-agent']) || '';

  const fbclid = attribution.fbclid || '';
  const fbc    = attribution.fbc || undefined;

  // Description contains user message and undedicated attribution fields (no duplicate dedicated fields)
  const descParts = [];
  if (message && String(message).trim()) {
    descParts.push(String(message).trim());
  }
  if (attribution.utm_campaign && String(attribution.utm_campaign).trim()) {
    descParts.push('UTM Campaign: ' + String(attribution.utm_campaign).trim());
  }
  if (attribution.utm_medium && String(attribution.utm_medium).trim()) {
    descParts.push('UTM Medium: ' + String(attribution.utm_medium).trim());
  }
  if (attribution.utm_source && String(attribution.utm_source).trim()) {
    descParts.push('UTM Source: ' + String(attribution.utm_source).trim());
  }
  const description = descParts.length > 0 ? descParts.join('\n') : undefined;

  // Zoho single-line text fields hold at most 255 characters; a longer value
  // makes Zoho reject the whole record. Only the Zoho copy is shortened —
  // Meta CAPI still receives the full values.
  const shortened = [];
  function fitZoho(v, field) {
    if (v === undefined || v === null || v === '') return undefined;
    const str = String(v);
    if (str.length <= ZOHO_TEXT_MAX) return str;
    let cut = str.slice(0, ZOHO_TEXT_MAX);
    // never leave half of a surrogate pair at the end
    if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
    shortened.push(field + ' truncated (' + str.length + ')');
    return cut;
  }
  // Click identifiers are never truncated: a partial ID would be misleading,
  // so an over-long one is left out of Zoho entirely.
  function wholeOrNone(v, field) {
    if (v === undefined || v === null || v === '') return undefined;
    const str = String(v);
    if (str.length <= ZOHO_TEXT_MAX) return str;
    shortened.push(field + ' omitted (' + str.length + ')');
    return undefined;
  }

  const record = {
    Last_Name:   lastName,
    First_Name:  firstName || undefined,
    Email:       email     || undefined,
    Mobile:      normalisePhone(phone) || phone || undefined,
    Company:     business  || undefined,
    Website:     website   || undefined,
    Lead_Source: getLeadSource(attribution),
    Lead_Status: 'Not Contacted',
    Lead_Type:   LEAD_TYPE_MAP[service] || undefined,
    Budget:
      BUDGET_MAP[budget_tier] ||
      BUDGET_MAP[budget] ||
      BUDGET_MAP[budget_label] ||
      budget ||
      budget_label ||
      undefined,
    Meta_FBP:    fitZoho(attribution.fbp, 'Meta_FBP'),
    Meta_FBCLID: wholeOrNone(fbclid, 'Meta_FBCLID'),
    Meta_FBC:    wholeOrNone(fbc, 'Meta_FBC'),
    Client_IP:   fitZoho(clientIp, 'Client_IP'),
    User_Agent:  fitZoho(userAgent, 'User_Agent'),
    Timeline:    fitZoho(timeline, 'Timeline'),
    Description: description,
  };

  // Field names and lengths only — never the values themselves
  if (shortened.length) console.warn('[Zoho] Field length limit:', shortened.join(', '));

  // Strip undefined keys so we don't send null values to Zoho
  Object.keys(record).forEach(function(k) {
    if (record[k] === undefined) delete record[k];
  });

  const res = await fetch('https://www.zohoapis.in/crm/v2/Leads', {
    method:  'POST',
    headers: {
      Authorization:  'Zoho-oauthtoken ' + accessToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ data: [record] }),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error('[Zoho] CRM API error:', res.status, text);
  } else {
    const json = await res.json().catch(function() { return null; });
    const result = json && json.data && json.data[0];
    if (!result || result.status !== 'success') {
      // Zoho can answer 2xx while rejecting the record itself
      console.error('[Zoho] CRM record rejected:', res.status, JSON.stringify(result || json));
    } else {
      console.info('[Zoho] Lead created:', JSON.stringify(result));
    }
  }
}

/* --- Vercel handler --------------------------------------------------------- */

module.exports = async function handler(req, res) {
  // Only accept POST
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  // Dynamic CORS: Allow production domain, vercel preview deployments, and local dev
  const origin = req.headers.origin || '';
  const isAllowedOrigin =
    origin === 'https://in.zyvextech.co' ||
    origin.endsWith('.zyvextech.co') ||
    origin.endsWith('.vercel.app') ||
    origin.startsWith('http://localhost:') ||
    origin.startsWith('http://127.0.0.1:');

  res.setHeader('Access-Control-Allow-Origin',  isAllowedOrigin ? origin : 'https://in.zyvextech.co');
  res.setHeader('Access-Control-Allow-Methods', 'POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  let body;
  try {
    body = typeof req.body === 'object' ? req.body : JSON.parse(req.body);
  } catch (err) {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }

  // Derive service name from the form kind when the frontend does not pass it
  const enrichedPayload = Object.assign({}, body, {
    service:     body.service     || (body.form === 'shopify' ? 'shopify' : 'full_stack_marketing'),
    attribution: normaliseAttribution(body.attribution),
  });

  // Fire both integrations concurrently; a failure in one never blocks the other
  const results = await Promise.allSettled([
    sendMetaCapi(enrichedPayload, req),
    createZohoLead(enrichedPayload, req),
  ]);

  results.forEach(function(r, i) {
    if (r.status === 'rejected') {
      console.error('[submit-lead] Integration', i, 'failed:', r.reason);
    }
  });

  return res.status(200).json({ ok: true });
};
