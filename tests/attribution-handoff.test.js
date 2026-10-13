// Tests for the zx_hid cross-browser handoff: api/attribution-handoff.js and its use in
// assets/attribution.js. Run: node --test tests/attribution-handoff.test.js
// Upstash is replaced by an in-memory fake with real TTL semantics; nothing leaves the process.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const { fakeUpstash, fakeRes, makeBrowser, loadPage, INSTAGRAM_UA } = require('./helpers/handoff-fakes');

process.env.UPSTASH_KV_REST_API_URL = 'https://fake-upstash.test';
process.env.UPSTASH_KV_REST_API_TOKEN = 'test-upstash-token';

const handler = require(path.join(__dirname, '..', 'api', 'attribution-handoff.js'));

const realNow = Date.now;
let offset = 0;
Date.now = () => realNow() + offset;
const clock = { now: () => Date.now() };
let upstash;
let logs;

test.beforeEach(() => {
  offset = 0;
  upstash = fakeUpstash(clock);
  global.fetch = upstash.fetch;
  logs = [];
  for (const k of ['info', 'warn', 'error']) console[k] = (...a) => logs.push(a.join(' '));
});

const ORIGIN = 'https://in.zyvextech.co';
const FBCLID = 'IwZXh0bgNhZW0BMABhZGlkAassAbCdEf_GhIjKlMn-0123456789';
const HID = 'A'.repeat(20) + 'b_c-'.repeat(5) + 'Z'.repeat(3);   // 43 chars

function click(over) {
  const ts = Date.now() - 60 * 1000;
  return Object.assign({ fbclid: FBCLID, fbc: 'fb.1.' + ts + '.' + FBCLID, ts, u: { utm_source: 'ig', utm_campaign: 'launch' } }, over);
}
async function call(body, o) {
  const opts = o || {};
  const res = fakeRes();
  await handler({
    method: opts.method || 'POST',
    headers: Object.assign({ origin: ORIGIN, 'content-length': String(JSON.stringify(body || {}).length) }, opts.headers),
    body,
  }, res);
  return res;
}
const register = (over, hid) => call(Object.assign({ action: 'register', hid: hid || HID }, click(over)));
const retrieve = hid => call({ action: 'retrieve', hid: hid || HID });

/* ── endpoint ── */

test('1. valid registration stores the click with SET NX EX 300 under a hashed key', async () => {
  const res = await register();
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true, ttl: 300 });
  const set = upstash.calls[0];
  assert.deepEqual([set[0], set[3], set[4], set[5]], ['SET', 'NX', 'EX', '300']);
  assert.ok(set[1].startsWith('zx:hid:'));
  assert.ok(!set[1].includes(HID), 'raw handle is not the Redis key');
  const stored = JSON.parse(set[2]);
  assert.deepEqual(Object.keys(stored).sort(), ['at', 'fbc', 'fbclid', 'ts', 'u', 'v']);
  assert.equal(res.headers['cache-control'], 'no-store, max-age=0');
});

test('register stores no PII or fbp even if the body carries it', async () => {
  const res = await call(Object.assign({ action: 'register', hid: HID, email: 'a@b.co', phone: '999', fbp: 'fb.1.1700000000000.123456' }, click()));
  assert.equal(res.statusCode, 200);
  const stored = upstash.calls[0][2];
  assert.ok(!/a@b\.co|999|fbp/.test(stored));
});

test('2. invalid fbc is rejected', async () => {
  for (const fbc of ['nope', 'fb.1.123.' + FBCLID, 'fb.9.' + Date.now() + '.' + FBCLID, '']) {
    const res = await register({ fbc });
    assert.equal(res.statusCode, 400, fbc);
    assert.equal(res.body.error, 'invalid_click');
  }
  assert.equal(upstash.calls.length, 0);
});

test('3. fbc/fbclid mismatch is rejected', async () => {
  const ts = Date.now();
  const res = await register({ fbc: 'fb.1.' + ts + '.OtherClickId_1234567890' });
  assert.equal(res.statusCode, 400);
  assert.equal(upstash.calls.length, 0);
});

test('stale or future clicks, bad UTMs and bad handles are rejected', async () => {
  const old = Date.now() - 61 * 60 * 1000;
  assert.equal((await register({ fbc: 'fb.1.' + old + '.' + FBCLID, ts: old })).statusCode, 400);
  const future = Date.now() + 60 * 60 * 1000;
  assert.equal((await register({ fbc: 'fb.1.' + future + '.' + FBCLID, ts: future })).statusCode, 400);
  assert.equal((await register({ u: { email: 'x@y.z' } })).statusCode, 400);
  assert.equal((await register({ u: { utm_source: 5 } })).statusCode, 400);
  for (const hid of ['short', HID + 'x', HID.slice(0, 42) + '!', 'user@example.com']) {
    assert.equal((await register({}, hid)).statusCode, 400, hid);
  }
  assert.equal(upstash.calls.length, 0);
});

test('method, origin, size and action are checked', async () => {
  assert.equal((await call({}, { method: 'GET' })).statusCode, 405);
  assert.equal((await call({ action: 'retrieve', hid: HID }, { headers: { origin: 'https://evil.example' } })).statusCode, 403);
  assert.equal((await call({ action: 'retrieve', hid: HID }, { headers: { origin: '' } })).statusCode, 403);
  assert.equal((await call({ action: 'retrieve', hid: HID }, { headers: { 'content-length': '9000' } })).statusCode, 413);
  assert.equal((await call(Object.assign({ action: 'register', hid: HID, pad: 'x'.repeat(5000) }, click()), { headers: { 'content-length': '10' } })).statusCode, 413);
  assert.equal((await call({ action: 'delete', hid: HID })).statusCode, 400);
  assert.equal((await call('{not json')).statusCode, 400);
  assert.equal(upstash.calls.length, 0);
});

test('4. successful retrieval returns the original click and deletes it atomically (GETDEL)', async () => {
  const c = click();
  await register(c);
  const res = await retrieve();
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true, fbclid: c.fbclid, fbc: c.fbc, ts: c.ts, u: c.u });
  assert.equal(upstash.calls[1][0], 'GETDEL');
  assert.equal(upstash.store.size, 0);
});

test('5. a record is gone 5 minutes after registration, and retrieval never extends it', async () => {
  await register();
  offset = 299 * 1000;
  assert.equal(upstash.store.size, 1);
  offset = 300 * 1000;
  const res = await retrieve();
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, { ok: false, error: 'not_found' });
  // only SET / GET / GETDEL are ever sent: no EXPIRE, PERSIST or SET without NX
  assert.ok(upstash.calls.every(c => ['SET', 'GET', 'GETDEL'].includes(c[0])));
});

test('6. a missing record is a plain 404', async () => {
  const res = await retrieve('Q'.repeat(43));
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, { ok: false, error: 'not_found' });
});

test('7. duplicate registration: identical retry succeeds, a different click is refused, TTL unchanged', async () => {
  const c = click();
  assert.equal((await register(c)).statusCode, 200);
  const exp = [...upstash.store.values()][0].exp;
  offset = 60 * 1000;
  const retry = await register(c);
  assert.equal(retry.statusCode, 200);
  assert.equal(retry.body.duplicate, true);
  const other = 'OtherClickId_1234567890';
  const ts = Date.now();
  const conflict = await register({ fbclid: other, fbc: 'fb.1.' + ts + '.' + other, ts });
  assert.equal(conflict.statusCode, 409);
  assert.equal(upstash.store.size, 1);
  assert.equal([...upstash.store.values()][0].exp, exp, 'expiry still measured from first registration');
  assert.equal(JSON.parse([...upstash.store.values()][0].value).fbclid, FBCLID);
});

test('8. replay: a second retrieval of the same handle finds nothing', async () => {
  await register();
  assert.equal((await retrieve()).statusCode, 200);
  assert.equal((await retrieve()).statusCode, 404);
});

test('9. storage unavailable or not configured → 503, nothing sensitive logged', async () => {
  upstash.down = true;
  assert.equal((await register()).statusCode, 503);
  assert.equal((await retrieve()).statusCode, 503);
  upstash.down = false;
  const url = process.env.UPSTASH_KV_REST_API_URL;
  delete process.env.UPSTASH_KV_REST_API_URL;
  const res = await register();
  process.env.UPSTASH_KV_REST_API_URL = url;
  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.body, { ok: false, error: 'storage_unavailable' });
  const all = logs.join('\n');
  assert.ok(!all.includes(FBCLID) && !all.includes(HID) && !all.includes('test-upstash-token'));
});

test('logs never contain handles, click ids or tokens', async () => {
  await register();
  await register({ fbclid: 'OtherClickId_1234567890', fbc: 'fb.1.' + Date.now() + '.OtherClickId_1234567890', ts: Date.now() });
  await retrieve();
  await retrieve();
  const all = logs.join('\n');
  assert.ok(logs.length >= 3);
  assert.ok(!all.includes(FBCLID) && !all.includes('OtherClickId') && !all.includes(HID) && !all.includes('test-upstash-token'));
});

/* ── browser flow (attribution.js against the real endpoint + fake Upstash) ── */

function api(origin) {
  return async body => {
    const res = fakeRes();
    await handler({ method: 'POST', headers: { origin: origin || ORIGIN, 'content-length': String(JSON.stringify(body).length) }, body }, res);
    return { status: res.statusCode, data: res.body };
  };
}
const AD_URL = '/shopify/?utm_source=ig&utm_medium=paid&utm_campaign=launch&fbclid=' + FBCLID + '#form';
const read = (b, k) => JSON.parse(b.storage.get(k) || 'null');

async function instagramLanding(o) {
  const ig = makeBrowser({ ua: INSTAGRAM_UA });
  const page = loadPage(ig, AD_URL, Object.assign({ api: api() }, o));
  await page.settle();
  return { ig, page };
}
function hidOf(url) { return new URL(url, ORIGIN).searchParams.get('zx_hid'); }

test('in-app landing registers a CSPRNG handle, then adds zx_hid keeping path, params and hash', async () => {
  const { ig, page } = await instagramLanding();
  assert.equal(page.apiCalls.length, 1);
  const body = page.apiCalls[0].body;
  assert.equal(body.action, 'register');
  assert.match(body.hid, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(page.apiCalls[0].endpoint, '/api/attribution-handoff/');
  const j = read(ig, 'zx_mj');
  assert.equal(body.fbc, j.fbc);
  assert.equal(body.ts, j.ts);
  assert.ok(!('fbp' in body));
  assert.equal(page.url(), AD_URL.replace('#form', '') + '&zx_hid=' + body.hid + '#form');
  assert.equal(page.replaced.length, 1, 'URL changed only after registration succeeded');
  assert.equal(read(ig, 'zx_hd').hid, body.hid);
});

test('handles are unique per registration', async () => {
  const a = await instagramLanding();
  const b = await instagramLanding();
  assert.notEqual(a.page.apiCalls[0].body.hid, b.page.apiCalls[0].body.hid);
});

test('registration failure: no carrier in the URL, normal attribution continues', async () => {
  upstash.down = true;
  const { ig, page } = await instagramLanding();
  assert.equal(page.apiCalls.length, 2, 'one retry with the same handle');
  assert.equal(page.apiCalls[0].body.hid, page.apiCalls[1].body.hid);
  assert.equal(hidOf(page.url()), null);
  assert.equal(read(ig, 'zx_hd'), null);
  assert.equal(page.win.zxAttribution().fbclid, FBCLID);
});

test('no CSPRNG or no fetch → no handoff attempted', async () => {
  for (const o of [{ noCrypto: true }, { noFetch: true }]) {
    const { page } = await instagramLanding(o);
    assert.equal(page.apiCalls.length, 0);
    assert.equal(hidOf(page.url()), null);
  }
});

test('the same visit is not re-registered on reloads or internal pages within 5 minutes', async () => {
  const { ig, page } = await instagramLanding();
  const hid = hidOf(page.url());
  const reload = loadPage(ig, page.url(), { api: api(), navType: 'reload' });
  await reload.settle();
  assert.equal(reload.apiCalls.length, 0);
  assert.equal(hidOf(reload.url()), hid);
  const internal = loadPage(ig, '/works/', { api: api(), referrer: ORIGIN + '/shopify/' });
  await internal.settle();
  assert.equal(internal.apiCalls.length, 0);
  assert.equal(internal.url(), '/works/?zx_hid=' + hid);
  // after the record lapses, a later in-app page registers a fresh handle (journey < 1 h)
  offset = 6 * 60 * 1000;
  const later = loadPage(ig, '/works/', { api: api(), referrer: ORIGIN + '/works/' });
  await later.settle();
  assert.equal(later.apiCalls.length, 1);
  assert.notEqual(hidOf(later.url()), hid);
  // after the 1-hour journey: no handle at all
  offset = 61 * 60 * 1000;
  const expired = loadPage(ig, '/works/?zx_hid=' + hidOf(later.url()), { api: api(), referrer: ORIGIN + '/works/' });
  await expired.settle();
  assert.equal(expired.apiCalls.length, 0);
  assert.equal(expired.url(), '/works/');
});

test('normal Chrome landing from an ad registers nothing', async () => {
  const chrome = makeBrowser();
  const page = loadPage(chrome, AD_URL, { api: api() });
  await page.settle();
  assert.equal(page.apiCalls.length, 0);
  assert.equal(page.url(), AD_URL);
});

async function handOver(o) {
  const { ig, page } = await instagramLanding();
  const hid = hidOf(page.url());
  const opts = o || {};
  if (opts.beforeChrome) opts.beforeChrome();
  const chrome = opts.chrome || makeBrowser({ cookies: { _fbp: 'fb.1.1760000000000.987654321' } });
  // Instagram's "Open in Chrome" with the fbclid lost but zx_hid kept (the case this exists for)
  const chromeUrl = opts.url || ('/shopify/?utm_source=ig&zx_hid=' + hid + '#form');
  const cp = loadPage(chrome, chromeUrl, { api: api() });
  await cp.settle();
  return { ig, page, hid, chrome, cp, igJourney: read(ig, 'zx_mj') };
}

test('15/16/17. Chrome redeems zx_hid: original fbc and time, its own fbp, carrier stripped', async () => {
  offset = 0;
  const igStart = Date.now();
  const { chrome, cp, igJourney } = await handOver({ beforeChrome: () => { offset = 2 * 60 * 1000; } });
  assert.equal(cp.apiCalls.length, 1);
  assert.deepEqual(Object.keys(cp.apiCalls[0].body).sort(), ['action', 'hid']);
  const j = read(chrome, 'zx_mj');
  assert.equal(j.fbclid, FBCLID);
  assert.equal(j.fbc, igJourney.fbc, 'original fbc, not a new one');
  assert.equal(j.ts, igJourney.ts, 'original journey time');
  assert.ok(j.ts <= igStart + 1000);
  assert.equal(j.u.utm_source, 'ig');
  assert.equal(j.u.utm_campaign, 'launch', 'campaign UTMs come from the handed-over click');
  const za = cp.win.zxAttribution();
  assert.equal(za.fbc, igJourney.fbc);
  assert.equal(za.fbclid, FBCLID);
  assert.equal(za.fbp, 'fb.1.1760000000000.987654321', "Chrome's own _fbp");
  assert.equal(za.meta_journey.source, 'meta');
  assert.ok(!JSON.stringify(za).includes('zx_hid'));
  assert.equal(cp.url(), '/shopify/?utm_source=ig#form');
  const lt = read(chrome, 'zx_lt');
  assert.equal(lt.fbclid, FBCLID);
  assert.equal(lt.ts, igJourney.ts, 'touch keeps the original click time');
  assert.equal(read(chrome, 'zx_ft').fbclid, FBCLID);
});

test('16. Chrome without its own _fbp gets none (fbp is never carried)', async () => {
  const { cp } = await handOver({ chrome: makeBrowser() });
  assert.equal(cp.win.zxAttribution().fbp, undefined);
  assert.equal(cp.win.zxAttribution().fbclid, FBCLID);
});

test('replay in another browser or a reload gets nothing', async () => {
  const { hid, cp } = await handOver();
  const other = loadPage(makeBrowser(), '/shopify/?zx_hid=' + hid, { api: api() });
  await other.settle();
  assert.equal(other.win.zxAttribution().fbclid, undefined);
  assert.equal(other.url(), '/shopify/');
  assert.equal(cp.win.zxAttribution().fbclid, FBCLID);
});

test('expired handle in Chrome: carrier removed, no fbc restored', async () => {
  const { chrome, cp } = await handOver({ beforeChrome: () => { offset = 5 * 60 * 1000 + 1000; } });
  assert.equal(cp.apiCalls.length, 1);
  assert.equal(read(chrome, 'zx_mj'), null);
  assert.equal(cp.win.zxAttribution().fbc, undefined);
  assert.equal(cp.url(), '/shopify/?utm_source=ig#form');
  assert.equal(read(chrome, 'zx_lt').fbclid, undefined);
});

test('storage outage during retrieval: no fbc, carrier kept so a reload can retry', async () => {
  const { chrome, cp, hid } = await handOver({ beforeChrome: () => { upstash.down = true; } });
  assert.equal(cp.win.zxAttribution().fbc, undefined);
  assert.equal(hidOf(cp.url()), hid);
  upstash.down = false;
  const reload = loadPage(chrome, cp.url(), { api: api(), navType: 'reload' });
  await reload.settle();
  assert.equal(reload.win.zxAttribution().fbclid, FBCLID);
  assert.equal(hidOf(reload.url()), null);
});

test('tampered backend answers are not trusted', async () => {
  const chrome = makeBrowser();
  const bad = [
    { ok: true, fbclid: FBCLID, fbc: 'fb.1.' + Date.now() + '.SomeoneElse_123456', ts: Date.now() },
    { ok: true, fbclid: FBCLID, fbc: 'garbage', ts: Date.now() },
    { ok: true, fbclid: FBCLID, fbc: 'fb.1.' + (Date.now() - 2 * 3600e3) + '.' + FBCLID, ts: Date.now() - 2 * 3600e3 },
  ];
  for (const data of bad) {
    const p = loadPage(chrome, '/?zx_hid=' + HID, { api: () => ({ status: 200, data }) });
    await p.settle();
    assert.equal(p.win.zxAttribution().fbc, undefined, JSON.stringify(data));
  }
});

test('10. a current Meta click in the URL wins: zx_hid is not redeemed, only stripped', async () => {
  const { ig, page, hid } = await instagramLanding().then(r => Object.assign(r, { hid: hidOf(r.page.url()) }));
  const chrome = makeBrowser();
  const cp = loadPage(chrome, page.url(), { api: api() });   // fbclid survived the handoff
  await cp.settle();
  assert.equal(cp.apiCalls.length, 0);
  assert.equal(hidOf(cp.url()), null);
  assert.equal(cp.url(), AD_URL.replace('#form', '') + '#form');
  const j = read(chrome, 'zx_mj');
  assert.equal(j.fbclid, FBCLID);
  assert.ok(j.fbc.endsWith('.' + FBCLID));
  assert.equal(upstash.store.size, 1, 'record left to expire on its own');
  assert.ok(ig && hid);
});

test('a click already used up in this browser is not restarted by a handoff', async () => {
  const chrome = makeBrowser();
  const { cp } = await handOver({ chrome });
  assert.equal(cp.win.zxAttribution().fbclid, FBCLID);
  // the journey ends (new external entry), then a second handoff of the same click arrives
  const direct = loadPage(chrome, '/');
  await direct.settle();
  assert.equal(direct.win.zxAttribution().fbclid, undefined);
  const again = await handOver({ chrome });
  assert.equal(again.cp.win.zxAttribution().fbclid, undefined);
});

test('11. direct visits never resurrect a stale fbc', async () => {
  const { chrome } = await handOver();
  offset = 10 * 60 * 1000;
  const direct = loadPage(chrome, '/');
  await direct.settle();
  assert.equal(direct.win.zxAttribution().fbc, undefined);
  assert.equal(direct.win.zxAttribution().fbclid, undefined);
  assert.equal(read(chrome, 'zx_mj').ended, true);
  // a forged / retired zx_mc carrier is ignored and stripped
  const payload = Buffer.from(JSON.stringify({ v: 1, c: FBCLID, t: Date.now(), ot: Date.now() })).toString('base64url');
  const forged = loadPage(makeBrowser(), '/?zx_mc=' + payload);
  await forged.settle();
  assert.equal(forged.win.zxAttribution().fbclid, undefined);
  assert.equal(forged.url(), '/');
});

test('12. Google and UTM capture unchanged', async () => {
  const b = makeBrowser();
  const p = loadPage(b, '/?utm_source=google&utm_medium=cpc&gclid=Cj0KCQjw_abcdefghij', { api: api() });
  await p.settle();
  assert.equal(p.apiCalls.length, 0);
  const za = p.win.zxAttribution();
  assert.equal(za.gclid, 'Cj0KCQjw_abcdefghij');
  assert.equal(za.utm_source, 'google');
  assert.equal(za.fbc, undefined);
  assert.equal(read(b, 'zx_lt').gclid, 'Cj0KCQjw_abcdefghij');
  // in-app browser with a gclid: no Meta handoff either
  const ig = makeBrowser({ ua: INSTAGRAM_UA });
  const g = loadPage(ig, '/?gclid=Cj0KCQjw_abcdefghij', { api: api() });
  await g.settle();
  assert.equal(g.apiCalls.length, 0);
});

test('13/14. first touch is permanent; latest touch keeps 90-day retention', async () => {
  const b = makeBrowser();
  const first = loadPage(b, '/?utm_source=newsletter');
  await first.settle();
  const ft = read(b, 'zx_ft');
  offset = 100 * 24 * 3600e3;
  const later = loadPage(b, '/?utm_source=ig&fbclid=' + FBCLID);
  await later.settle();
  assert.deepEqual(read(b, 'zx_ft'), ft, 'first touch never replaced');
  assert.deepEqual(later.win.zxAttribution().first_touch, ft);
  assert.equal(read(b, 'zx_lt').utm_source, 'ig');
  offset += 89 * 24 * 3600e3;
  assert.equal(loadPage(b, '/').win.zxAttribution().latest_touch.utm_source, 'ig');
  offset += 2 * 24 * 3600e3;
  assert.equal(loadPage(b, '/').win.zxAttribution().latest_touch, undefined);
  assert.deepEqual(loadPage(b, '/').win.zxAttribution().first_touch, ft);
});

test('handoff into a browser with an existing first touch keeps it', async () => {
  const chrome = makeBrowser();
  const prior = loadPage(chrome, '/?utm_source=newsletter');
  await prior.settle();
  const ft = read(chrome, 'zx_ft');
  await handOver({ chrome });
  assert.deepEqual(read(chrome, 'zx_ft'), ft);
  assert.equal(read(chrome, 'zx_lt').fbclid, FBCLID);
});

/* ── pages and the existing conversion path ── */

const ROOT = path.join(__dirname, '..');
function htmlFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === '.git' || e.name === 'node_modules' ? [] : htmlFiles(p);
    return e.name.endsWith('.html') ? [p] : [];
  });
}

test('19/11. all 18 HTML pages load attribution.js?v=8, both landing pages included', () => {
  const files = htmlFiles(ROOT);
  assert.equal(files.length, 18);
  for (const f of files) {
    const refs = fs.readFileSync(f, 'utf8').match(/\/assets\/attribution\.js\?v=\d+/g) || [];
    assert.deepEqual(refs, ['/assets/attribution.js?v=8'], path.relative(ROOT, f));
  }
  for (const f of ['index.html', 'shopify/index.html']) {
    const html = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.ok(html.includes('window.zxAttribution()'), f + ' still reads attribution at submit');
    assert.ok(!html.includes('zx_hid'), f + ' never sends zx_hid');
  }
});

test('18. lead form still sends the recovered fbc through the unchanged CAPI path', async () => {
  // The form builds its payload from window.zxAttribution(); submit-lead.js is unchanged.
  const { cp } = await handOver();
  const za = cp.win.zxAttribution();
  Object.assign(process.env, { META_PIXEL_ID: 'p', META_CAPI_TOKEN: 't' });
  const submit = require(path.join(ROOT, 'api', 'submit-lead.js'));
  const sent = [];
  global.fetch = async (url, opts) => {
    sent.push({ url, body: opts && opts.body ? JSON.parse(opts.body) : null });
    return { ok: true, status: 200, json: async () => ({ data: [{ status: 'success' }] }), text: async () => '' };
  };
  const res = fakeRes();
  await submit({ method: 'POST', headers: { origin: ORIGIN }, body: {
    form: 'shopify', name: 'T', email: 't@example.com', phone: '+91 9000000000', business: 'B',
    budget_tier: '50k-1l', budget_label: '₹50K - ₹1L', event_id: 'zx-evt-1', page: '/shopify/',
    attribution: { fbc: za.fbc, fbclid: za.fbclid, fbp: za.fbp, meta_journey: za.meta_journey },
  } }, res);
  const capi = sent.find(s => s.url.includes('graph.facebook.com'));
  assert.ok(capi, 'CAPI called');
  const ev = capi.body.data[0];
  assert.equal(ev.event_id, 'zx-evt-1', 'event_id passed through unchanged');
  assert.equal(ev.user_data.fbc, za.fbc);
  assert.equal(ev.user_data.fbp, za.fbp);
  assert.ok(!JSON.stringify(sent).includes('zx_hid'));
});

test('20. endpoint and script load', () => {
  assert.equal(typeof handler, 'function');
  assert.equal(handler._internal.TTL_SECONDS, 300);
  const p = loadPage(makeBrowser(), '/');
  assert.equal(typeof p.win.zxAttribution, 'function');
});
