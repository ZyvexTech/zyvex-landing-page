// Tests for api/zoho-deal-qualified.js (qualified Deal → Meta CAPI).
// Run: node --test tests/zoho-deal-qualified.test.js
// fetch is mocked with an in-memory Zoho + Meta, so nothing reaches either service.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const path = require('path');

const SECRET = 'test-webhook-secret-0123456789abcdef-XYZ';
Object.assign(process.env, {
  META_PIXEL_ID: 'test-pixel',
  META_CAPI_TOKEN: 'test-capi-token',
  ZOHO_CLIENT_ID: 'test-client',
  ZOHO_CLIENT_SECRET: 'test-client-secret',
  ZOHO_DEALS_REFRESH_TOKEN: 'test-deals-refresh',
  ZOHO_WEBHOOK_SECRET: SECRET,
});

const handler = require(path.join(__dirname, '..', 'api', 'zoho-deal-qualified.js'));

const DEAL_ID = '1306555000001257005';
const CONTACT_ID = '1306555000001257004';
const LEAD_ID = '1306555000001246026';
const FBC = 'fb.1.1791361483605.PAZXh0bgNhZW0BMABwZG9mAmFkaWQBqzi';
const FBP = 'fb.1.1791361483630.702814733311058774';
const EMAIL = 'Person@Example.com';
const PHONE = '+91 98765 43210';
const IP = '49.205.104.112';
const UA = 'Mozilla/5.0 (Linux; Android 15) TestAgent/1.0';

function sha(v) { return crypto.createHash('sha256').update(v.trim().toLowerCase()).digest('hex'); }

/* ---- in-memory Zoho + Meta ---- */

let state;
let calls;
let logs = [];

function reset(overrides) {
  const o = overrides || {};
  state = {
    deal: o.deal === null ? null : Object.assign({
      id: DEAL_ID,
      Created_Time: new Date(Date.now() - 60 * 1000).toISOString(),
      Amount: 25000,
      Stage: 'Qualification',
      Contact_Name: { id: CONTACT_ID },
      Meta_FBC: FBC, Meta_FBP: FBP, Client_IP: IP, User_Agent: UA,
      Tag: [],
    }, o.deal),
    lead: o.lead === null ? null : Object.assign({
      id: LEAD_ID,
      Lead_Type: 'Full Stack Marketing',
      Lead_Source: 'Direct',
      Email: 'old@example.com', Mobile: '+919999999999',
      Meta_FBC: FBC, Meta_FBP: FBP, Client_IP: IP, User_Agent: UA,
    }, o.lead),
    extraLead: !!o.extraLead,
    contact: o.contact === null ? null : Object.assign({ id: CONTACT_ID, Email: EMAIL, Mobile: PHONE }, o.contact),
    tokenFails: !!o.tokenFails,
    coqlError: o.coqlError || null,
    tagFails: o.tagFails || {},          // { 'add_tags:meta-qualified-pending': true }
    metaResponses: (o.metaResponses || [{ status: 200, json: { events_received: 1, fbtrace_id: 'trace-ok' } }]).slice(),
  };
  calls = [];
}

function respond(status, json) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => { if (json === undefined) throw new Error('no body'); return json; },
    text: async () => JSON.stringify(json || {}),
  };
}

global.fetch = async function (url, opts) {
  const u = new URL(url);
  const call = { url, method: opts.method, body: opts.body ? JSON.parse(opts.body) : undefined, headers: opts.headers };
  calls.push(call);

  if (u.host === 'accounts.zoho.in') {
    return state.tokenFails ? respond(400, { error: 'invalid_code' }) : respond(200, { access_token: 'test-access' });
  }
  if (u.host === 'graph.facebook.com') {
    const r = state.metaResponses.length > 1 ? state.metaResponses.shift() : state.metaResponses[0];
    if (r.throws) throw new Error('network down');
    return respond(r.status, r.json);
  }
  if (u.host === 'www.zohoapis.in') {
    // COQL must use v8 (v2 rejects Converted_Deal); every other call stays on v2.
    const isCoql = u.pathname === '/crm/v8/coql';
    if (!isCoql) assert.ok(u.pathname.startsWith('/crm/v2/'), 'unexpected Zoho path ' + u.pathname);
    const p = isCoql ? '/coql' : u.pathname.replace('/crm/v2', '');
    if (p === '/Deals/' + DEAL_ID && opts.method === 'GET') {
      return state.deal ? respond(200, { data: [JSON.parse(JSON.stringify(state.deal))] }) : respond(204);
    }
    if (p === '/coql') {
      if (state.coqlError) return respond(state.coqlError.status, state.coqlError.json);
      assert.match(call.body.select_query, new RegExp('Converted__s = true and Converted_Deal = ' + DEAL_ID));
      if (!state.lead) return respond(204);
      const rows = [state.lead].concat(state.extraLead ? [Object.assign({}, state.lead, { id: '999' })] : []);
      return respond(200, { data: rows });
    }
    if (p === '/Contacts/' + CONTACT_ID) {
      return state.contact ? respond(200, { data: [state.contact] }) : respond(204);
    }
    const m = p.match(/^\/Deals\/(\d+)\/actions\/(add_tags|remove_tags)$/);
    if (m) {
      const name = u.searchParams.get('tag_names');
      if (state.tagFails[m[2] + ':' + name]) return respond(403, { code: 'NO_PERMISSION', status: 'error' });
      if (state.deal) {
        const tags = state.deal.Tag.filter((t) => t.name !== name);
        if (m[2] === 'add_tags') tags.push({ name });
        state.deal.Tag = tags;
      }
      return respond(200, { data: [{ code: 'SUCCESS', status: 'success' }] });
    }
  }
  throw new Error('unexpected request ' + url);
};

for (const level of ['info', 'warn', 'error', 'log']) {
  console[level] = function () { logs.push(Array.from(arguments).join(' ')); };
}

async function call(opts) {
  const o = opts || {};
  let status, body;
  const headers = {};
  const res = {
    setHeader(k, v) { headers[k] = v; },
    status(code) { status = code; return this; },
    json(b) { body = b; return this; },
  };
  const reqHeaders = o.headers || { 'x-zyvex-webhook-secret': SECRET };
  await handler({
    method: o.method || 'POST',
    headers: reqHeaders,
    body: o.body !== undefined ? o.body : { deal_id: DEAL_ID },
  }, res);
  return { status, body, headers };
}

const metaCalls = () => calls.filter((c) => c.url.includes('graph.facebook.com'));
const tagCalls = () => calls.filter((c) => c.url.includes('/actions/'));
const tagNames = () => state.deal.Tag.map((t) => t.name);

/* ---- method and authentication ---- */

test('non-POST methods get 405 and touch nothing', async () => {
  for (const method of ['GET', 'PUT', 'DELETE', 'OPTIONS']) {
    reset();
    const r = await call({ method });
    assert.equal(r.status, 405);
    assert.equal(r.headers.Allow, 'POST');
    assert.equal(calls.length, 0);
  }
});

test('missing or wrong secret gets 401 and touches nothing', async () => {
  for (const headers of [{}, { 'x-zyvex-webhook-secret': 'wrong' }, { 'x-zyvex-webhook-secret': SECRET + 'x' }, { authorization: SECRET }]) {
    reset();
    const r = await call({ headers });
    assert.equal(r.status, 401);
    assert.equal(calls.length, 0);
  }
});

test('a missing or too-short secret in the environment fails closed', async () => {
  const saved = process.env.ZOHO_WEBHOOK_SECRET;
  for (const value of ['', 'short-secret']) {
    process.env.ZOHO_WEBHOOK_SECRET = value;
    reset();
    const r = await call({ headers: { 'x-zyvex-webhook-secret': value } });
    assert.equal(r.status, 503);
    assert.equal(calls.length, 0);
  }
  process.env.ZOHO_WEBHOOK_SECRET = saved;
});

test('missing Zoho deal credentials fail closed', async () => {
  const saved = process.env.ZOHO_DEALS_REFRESH_TOKEN;
  delete process.env.ZOHO_DEALS_REFRESH_TOKEN;
  reset();
  const r = await call();
  assert.equal(r.status, 503);
  assert.equal(calls.length, 0);
  process.env.ZOHO_DEALS_REFRESH_TOKEN = saved;
});

test('an invalid or missing Deal ID gets 400', async () => {
  for (const body of [{}, { deal_id: 'abc' }, { deal_id: '123' }, { deal_id: DEAL_ID + ' or 1=1' }, 'not json', null]) {
    reset();
    const r = await call({ body });
    assert.equal(r.status, 400);
    assert.equal(calls.length, 0);
  }
});

/* ---- Lead Type mapping ---- */

test('Shopify Builds sends QualifiedShopifyLead with Zoho data only', async () => {
  reset({ lead: { Lead_Type: 'Shopify Builds', Lead_Source: 'Meta Ads' } });
  const r = await call();
  assert.equal(r.status, 200);
  assert.equal(r.body.result, 'sent');

  const [m] = metaCalls();
  assert.equal(m.url, 'https://graph.facebook.com/v26.0/test-pixel/events');
  assert.ok(!m.url.includes('access_token'), 'token must not be in the URL');
  assert.equal(m.body.access_token, 'test-capi-token');
  const e = m.body.data[0];
  assert.equal(e.event_name, 'QualifiedShopifyLead');
  assert.equal(e.event_id, 'zxq-' + DEAL_ID);
  assert.equal(e.action_source, 'website');
  assert.equal(e.event_source_url, 'https://in.zyvextech.co/shopify/');
  assert.equal(e.event_time, Math.floor(Date.parse(state.deal.Created_Time) / 1000));
  assert.deepEqual(e.custom_data, { content_name: 'shopify', currency: 'INR', value: 25000 });
  assert.deepEqual(e.user_data.em, [sha(EMAIL)]);
  assert.deepEqual(e.user_data.ph, [sha('+919876543210')]);
  assert.equal(e.user_data.client_ip_address, IP);
  assert.equal(e.user_data.client_user_agent, UA);
  assert.equal(e.user_data.fbc, FBC);
  assert.equal(e.user_data.fbp, FBP);
  assert.deepEqual(tagNames(), ['meta-qualified-sent']);
});

test('Full Stack Marketing sends QualifiedFullStackLead (Direct leads included)', async () => {
  reset({ lead: { Lead_Type: 'Full Stack Marketing', Lead_Source: 'Direct' } });
  const r = await call();
  assert.equal(r.status, 200);
  const e = metaCalls()[0].body.data[0];
  assert.equal(e.event_name, 'QualifiedFullStackLead');
  assert.equal(e.event_source_url, 'https://in.zyvextech.co/');
  assert.equal(e.custom_data.content_name, 'full_stack_marketing');
});

test('unsupported Lead Types, including legacy "Shopify", are skipped', async () => {
  for (const type of ['Shopify', 'shopify builds', 'Other', '', null, undefined, '__proto__', 'constructor']) {
    reset({ lead: { Lead_Type: type } });
    const r = await call();
    assert.equal(r.status, 200);
    assert.equal(r.body.result, 'skipped');
    assert.equal(r.body.reason, 'unsupported_lead_type');
    assert.equal(metaCalls().length, 0);
    assert.equal(tagCalls().length, 0);
  }
});

test('values supplied by the webhook are ignored', async () => {
  reset({ lead: { Lead_Type: 'Full Stack Marketing' } });
  await call({ body: {
    deal_id: DEAL_ID, lead_type: 'Shopify Builds', Lead_Type: 'Shopify Builds', amount: 999999,
    email: 'attacker@example.com', fbc: 'fb.1.1791361483605.FAKEFAKEFAKEFAKE', event_name: 'Purchase',
  } });
  const e = metaCalls()[0].body.data[0];
  assert.equal(e.event_name, 'QualifiedFullStackLead');
  assert.equal(e.custom_data.value, 25000);
  assert.deepEqual(e.user_data.em, [sha(EMAIL)]);
  assert.equal(e.user_data.fbc, FBC);
});

test('form-encoded and JSON-string bodies are accepted', async () => {
  for (const body of ['deal_id=' + DEAL_ID, JSON.stringify({ deal_id: DEAL_ID }), Buffer.from('deal_id=' + DEAL_ID)]) {
    reset();
    const r = await call({ body });
    assert.equal(r.status, 200);
    assert.equal(r.body.result, 'sent');
  }
});

/* ---- event content ---- */

test('value is omitted when the Deal has no positive INR Amount', async () => {
  for (const deal of [{ Amount: null }, { Amount: 0 }, { Amount: '25000' }, { Amount: 5000, Currency: 'USD' }]) {
    reset({ deal });
    await call();
    const cd = metaCalls()[0].body.data[0].custom_data;
    assert.ok(!('value' in cd), JSON.stringify(deal));
    assert.equal(cd.currency, 'INR');
  }
});

test('fbc and fbp are sent only as stored, never fabricated', async () => {
  reset({ lead: { Meta_FBC: null, Meta_FBP: null }, deal: { Meta_FBC: null, Meta_FBP: null } });
  await call();
  let ud = metaCalls()[0].body.data[0].user_data;
  assert.ok(!('fbc' in ud));
  assert.ok(!('fbp' in ud));

  reset({ lead: { Meta_FBC: 'not-an-fbc', Meta_FBP: 'nope' }, deal: { Meta_FBC: null, Meta_FBP: null } });
  await call();
  ud = metaCalls()[0].body.data[0].user_data;
  assert.ok(!('fbc' in ud));
  assert.ok(!('fbp' in ud));
});

test('contact details fall back to the converted Lead when there is no Contact', async () => {
  reset({ contact: null, deal: { Contact_Name: null } });
  await call();
  const ud = metaCalls()[0].body.data[0].user_data;
  assert.deepEqual(ud.em, [sha('old@example.com')]);
  assert.deepEqual(ud.ph, [sha('+919999999999')]);
});

/* ---- missing records ---- */

test('missing Deal is skipped without sending', async () => {
  reset({ deal: null });
  const r = await call();
  assert.equal(r.status, 200);
  assert.equal(r.body.reason, 'deal_not_found');
  assert.equal(metaCalls().length, 0);
});

test('Deal without a converted Lead (manual Deal) is skipped', async () => {
  reset({ lead: null });
  const r = await call();
  assert.equal(r.status, 200);
  assert.equal(r.body.reason, 'no_converted_lead');
  assert.equal(metaCalls().length, 0);
  assert.equal(tagCalls().length, 0);
});

test('more than one Lead for the Deal is skipped', async () => {
  reset({ extraLead: true });
  const r = await call();
  assert.equal(r.status, 200);
  assert.equal(r.body.reason, 'ambiguous_lead');
  assert.equal(metaCalls().length, 0);
});

test('Deals older than Meta\'s 7-day window are skipped', async () => {
  reset({ deal: { Created_Time: new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString() } });
  const r = await call();
  assert.equal(r.body.reason, 'deal_too_old');
  assert.equal(metaCalls().length, 0);
});

test('no User Agent anywhere means skip, since Meta requires it for website events', async () => {
  reset({ lead: { User_Agent: null }, deal: { User_Agent: null } });
  const r = await call();
  assert.equal(r.body.reason, 'no_user_agent');
  assert.equal(metaCalls().length, 0);
});

/* ---- API failures ---- */

test('Zoho token failure stops before Meta', async () => {
  reset({ tokenFails: true });
  const r = await call();
  assert.equal(r.status, 503);
  assert.equal(r.body.reason, 'zoho_auth_failed');
  assert.equal(metaCalls().length, 0);
});

test('missing Zoho OAuth scope stops before Meta', async () => {
  reset({ coqlError: { status: 401, json: { code: 'OAUTH_SCOPE_MISMATCH', status: 'error' } } });
  const r = await call();
  assert.equal(r.status, 503);
  assert.equal(r.body.reason, 'zoho_scope_missing');
  assert.equal(metaCalls().length, 0);
});

test('Zoho server error stops before Meta', async () => {
  reset({ coqlError: { status: 500, json: { code: 'INTERNAL_ERROR' } } });
  const r = await call();
  assert.equal(r.status, 503);
  assert.equal(metaCalls().length, 0);
});

test('converted-Lead COQL goes to v8; Deal, Contact and tag calls stay on v2', async () => {
  reset();
  const r = await call();
  assert.equal(r.status, 200);
  const zohoCalls = calls.filter((c) => c.url.startsWith('https://www.zohoapis.in/'));
  const coql = zohoCalls.filter((c) => c.url.endsWith('/coql'));
  assert.deepEqual(coql.map((c) => c.url), ['https://www.zohoapis.in/crm/v8/coql']);
  assert.match(coql[0].body.select_query, /where Converted__s = true and Converted_Deal = \d+ limit 2$/);
  for (const c of zohoCalls.filter((c) => !c.url.endsWith('/coql'))) {
    assert.ok(c.url.startsWith('https://www.zohoapis.in/crm/v2/'), c.url);
  }
});

test('a COQL INVALID_QUERY logs the rejected column name', async () => {
  reset({ coqlError: { status: 400, json: { code: 'INVALID_QUERY', status: 'error',
    message: 'column given seems to be invalid', details: { column_name: 'Converted_Deal' } } } });
  logs = [];
  const r = await call();
  assert.equal(r.status, 503);
  assert.equal(r.body.reason, 'zoho_error_400');
  assert.equal(metaCalls().length, 0);
  const line = logs.find((l) => l.startsWith('[deal-qualified] Zoho API error'));
  assert.ok(line);
  const logged = JSON.parse(line.slice('[deal-qualified] Zoho API error '.length));
  assert.equal(logged.path, '/coql');
  assert.equal(logged.code, 'INVALID_QUERY');
  assert.equal(logged.column, 'Converted_Deal');
});

test('if the pending marker cannot be written, nothing is sent to Meta', async () => {
  reset({ tagFails: { 'add_tags:meta-qualified-pending': true } });
  const r = await call();
  assert.equal(r.status, 503);
  assert.equal(r.body.reason, 'marker_unavailable');
  assert.equal(metaCalls().length, 0);
});

test('the pending marker is written before the Meta call', async () => {
  reset();
  await call();
  const order = calls.map((c) => c.url.includes('graph.facebook.com') ? 'meta'
    : c.url.includes('add_tags') ? 'add:' + new URL(c.url).searchParams.get('tag_names') : null).filter(Boolean);
  assert.deepEqual(order, ['add:meta-qualified-pending', 'meta', 'add:meta-qualified-sent']);
});

/* ---- Meta rejection / transient failures ---- */

test('Meta rejection is not marked as sent and can be retried', async () => {
  reset({ metaResponses: [{ status: 400, json: { error: { code: 100, error_subcode: 2804003, message: 'bad', fbtrace_id: 'trace-bad' } } }] });
  const r = await call();
  assert.equal(r.status, 502);
  assert.equal(r.body.reason, 'meta_rejected');
  assert.deepEqual(tagNames(), []);
});

test('events_received other than 1 is not treated as accepted', async () => {
  reset({ metaResponses: [{ status: 200, json: { events_received: 0, fbtrace_id: 't' } }] });
  const r = await call();
  assert.notEqual(r.status, 200);
  assert.ok(!tagNames().includes('meta-qualified-sent'));
});

test('transient Meta failure returns 503, then a retry sends exactly once', async () => {
  reset({ metaResponses: [
    { status: 500, json: { error: { code: 2 } } },
    { throws: true },
    { status: 200, json: { events_received: 1, fbtrace_id: 'trace-ok' } },
  ] });
  let r = await call();
  assert.equal(r.status, 503);
  assert.equal(r.body.reason, 'meta_unavailable');
  r = await call();
  assert.equal(r.status, 503);
  r = await call();
  assert.equal(r.status, 200);
  assert.equal(r.body.result, 'sent');
  r = await call();
  assert.equal(r.body.result, 'duplicate');
  assert.equal(metaCalls().length, 3);
  const ids = new Set(metaCalls().map((c) => c.body.data[0].event_id));
  assert.deepEqual([...ids], ['zxq-' + DEAL_ID]);
});

/* ---- duplicates ---- */

test('repeated delivery of the same Deal sends to Meta only once', async () => {
  reset();
  const first = await call();
  const second = await call();
  const third = await call();
  assert.equal(first.body.result, 'sent');
  assert.equal(second.body.result, 'duplicate');
  assert.equal(third.body.result, 'duplicate');
  assert.equal(metaCalls().length, 1);
});

test('a Deal already tagged as sent is never sent', async () => {
  reset({ deal: { Tag: [{ name: 'meta-qualified-sent' }] } });
  const r = await call();
  assert.equal(r.status, 200);
  assert.equal(r.body.result, 'duplicate');
  assert.equal(metaCalls().length, 0);
});

test('accepted by Meta but sent marker fails: 200 so Zoho does not redeliver', async () => {
  reset({ tagFails: { 'add_tags:meta-qualified-sent': true } });
  const r = await call();
  assert.equal(r.status, 200);
  assert.equal(r.body.result, 'sent_unmarked');
  assert.equal(metaCalls().length, 1);
});

/* ---- logging ---- */

test('logs never contain secrets or personal data', async () => {
  logs = [];
  reset({ lead: { Lead_Type: 'Shopify Builds' } });
  await call();
  reset({ metaResponses: [{ status: 400, json: { error: { code: 100, message: 'Invalid ' + EMAIL, fbtrace_id: 'x' } } }] });
  await call();
  reset();
  await call({ headers: { 'x-zyvex-webhook-secret': 'wrong-' + SECRET } });

  const all = logs.join('\n');
  assert.ok(logs.length >= 3);
  const forbidden = [SECRET, 'test-capi-token', 'test-access', 'test-deals-refresh', 'test-client-secret',
    EMAIL, EMAIL.toLowerCase(), 'old@example.com', '98765', '9999999999', IP, UA, 'TestAgent', FBC, FBP,
    sha(EMAIL), sha('+919876543210')];
  for (const f of forbidden) assert.ok(!all.includes(f), 'log leaked: ' + f);

  const sent = logs.find((l) => l.includes('"result":"sent"'));
  const parsed = JSON.parse(sent.replace('[deal-qualified] ', ''));
  assert.deepEqual(Object.keys(parsed).sort(),
    ['deal_id', 'event', 'events_received', 'fbtrace_id', 'meta_status', 'result'].sort());
  assert.equal(parsed.deal_id, DEAL_ID);
  assert.equal(parsed.events_received, 1);
  assert.equal(parsed.fbtrace_id, 'trace-ok');
});

/* ---- META_TEST_EVENT_CODE (Preview only) ---- */

function withTestCode(value, fn) {
  return async () => {
    const saved = process.env.META_TEST_EVENT_CODE;
    if (value === undefined) delete process.env.META_TEST_EVENT_CODE;
    else process.env.META_TEST_EVENT_CODE = value;
    try { await fn(); } finally {
      if (saved === undefined) delete process.env.META_TEST_EVENT_CODE;
      else process.env.META_TEST_EVENT_CODE = saved;
    }
  };
}

test('without META_TEST_EVENT_CODE no test_event_code is sent', withTestCode(undefined, async () => {
  logs = [];
  reset();
  const r = await call();
  assert.equal(r.status, 200);
  const body = metaCalls()[0].body;
  assert.ok(!('test_event_code' in body));
  assert.deepEqual(Object.keys(body).sort(), ['access_token', 'data']);
  assert.ok(!logs.join('\n').includes('test_event'));
}));

test('an empty or blank META_TEST_EVENT_CODE counts as unset', withTestCode('   ', async () => {
  reset();
  const r = await call();
  assert.equal(r.status, 200);
  assert.ok(!('test_event_code' in metaCalls()[0].body));
}));

test('META_TEST_EVENT_CODE is sent as test_event_code to the same dataset', withTestCode(' TEST12345 ', async () => {
  logs = [];
  reset({ lead: { Lead_Type: 'Shopify Builds' } });
  const r = await call();
  assert.equal(r.status, 200);
  const m = metaCalls()[0];
  assert.equal(m.url, 'https://graph.facebook.com/v26.0/test-pixel/events');
  assert.equal(m.body.test_event_code, 'TEST12345');
  assert.equal(m.body.data[0].event_name, 'QualifiedShopifyLead');
  assert.equal(m.body.data[0].event_id, 'zxq-' + DEAL_ID);
  const line = logs.find((l) => l.includes('"result":"sent"'));
  assert.ok(line.includes('"test_event":true'));
  assert.ok(!line.includes('TEST12345'), 'the code itself is not logged');
}));

test('test mode keeps duplicate prevention: second delivery is a duplicate', withTestCode('TEST12345', async () => {
  reset();
  await call();
  const r = await call();
  assert.equal(r.body.result, 'duplicate');
  assert.equal(metaCalls().length, 1);
}));

test('a malformed META_TEST_EVENT_CODE fails closed instead of sending a real event', withTestCode('bad code!', async () => {
  reset();
  const r = await call();
  assert.equal(r.status, 503);
  assert.equal(calls.length, 0);
}));

/* ---- Tag field hardening ---- */

test('a Deal response without a valid Tag array fails closed: 503 tag_field_missing, nothing sent', async () => {
  for (const tag of [undefined, null, '', 'meta-qualified-sent', {}, { name: 'meta-qualified-sent' }]) {
    reset({ deal: { Tag: tag } });
    if (tag === undefined) delete state.deal.Tag;
    const r = await call();
    assert.equal(r.status, 503, JSON.stringify(tag));
    assert.equal(r.body.result, 'failed');
    assert.equal(r.body.reason, 'tag_field_missing');
    assert.equal(metaCalls().length, 0);
    assert.equal(tagCalls().length, 0);
  }
});
