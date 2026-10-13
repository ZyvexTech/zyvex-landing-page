// Test fakes for the zx_hid handoff: an Upstash REST stand-in with a controllable clock,
// and a minimal browser window that runs assets/attribution.js in a vm context.
// Nothing here reaches Upstash, Meta or Zoho.

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ATTRIBUTION_SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'assets', 'attribution.js'), 'utf8');

// Upstash REST: POST <url> with a JSON command array, Bearer token. Supports what the
// endpoint uses (SET … NX EX n, GET, GETDEL). Expiry follows clock.now().
function fakeUpstash(clock) {
  const store = new Map();
  const state = { store, calls: [], down: false };
  function live(key) {
    const e = store.get(key);
    if (!e) return null;
    if (e.exp <= clock.now()) { store.delete(key); return null; }
    return e;
  }
  state.fetch = async function (url, opts) {
    if (state.down) throw new Error('ECONNREFUSED');
    if (opts.headers.Authorization !== 'Bearer test-upstash-token') {
      return { ok: false, status: 401, json: async () => ({ error: 'unauthorized' }) };
    }
    const cmd = JSON.parse(opts.body);
    state.calls.push(cmd);
    const [op, key] = cmd;
    let result = null;
    if (op === 'SET') {
      const nx = cmd.includes('NX');
      const exIdx = cmd.indexOf('EX');
      if (!nx || exIdx < 0) throw new Error('test fake: SET must use NX and EX');
      if (!live(key)) {
        store.set(key, { value: cmd[2], exp: clock.now() + Number(cmd[exIdx + 1]) * 1000 });
        result = 'OK';
      }
    } else if (op === 'GET') {
      const e = live(key); result = e ? e.value : null;
    } else if (op === 'GETDEL') {
      const e = live(key); result = e ? e.value : null; store.delete(key);
    } else {
      return { ok: false, status: 400, json: async () => ({ error: 'ERR unknown command' }) };
    }
    return { ok: true, status: 200, json: async () => ({ result }) };
  };
  return state;
}

function fakeRes() {
  const res = {
    statusCode: 0, headers: {}, body: undefined,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    status(code) { this.statusCode = code; return this; },
    json(b) { this.body = b; return this; },
  };
  return res;
}

// A browser: its own localStorage and cookies, persisting across page loads.
function makeBrowser(opts) {
  const o = opts || {};
  return {
    ua: o.ua || 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36',
    storage: new Map(),
    cookies: o.cookies || {},
  };
}
const INSTAGRAM_UA = 'Mozilla/5.0 (Linux; Android 14; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0 Mobile Safari/537.36 Instagram 300.0.0';

// Loads one page in `browser` and runs attribution.js. `api(body)` answers the handoff
// endpoint with {status, data}. Returns the window plus helpers.
function loadPage(browser, url, o) {
  const opts = o || {};
  const u = new URL(url, 'https://in.zyvextech.co');
  const pending = [];
  const apiCalls = [];
  const replaced = [];
  const location = { origin: u.origin, pathname: u.pathname, search: u.search, hash: u.hash };
  const win = {
    navigator: { userAgent: browser.ua },
    location,
    history: {
      state: null,
      replaceState(state, title, next) {
        const n = new URL(next, u.origin);
        location.pathname = n.pathname; location.search = n.search; location.hash = n.hash;
        replaced.push(next);
      },
    },
    localStorage: {
      getItem: k => (browser.storage.has(k) ? browser.storage.get(k) : null),
      setItem: (k, v) => browser.storage.set(k, String(v)),
      removeItem: k => browser.storage.delete(k),
    },
    document: {
      referrer: opts.referrer || '',
      get cookie() { return Object.entries(browser.cookies).map(([k, v]) => k + '=' + v).join('; '); },
    },
    performance: { getEntriesByType: () => [{ type: opts.navType || 'navigate' }] },
    crypto: opts.noCrypto ? undefined : { getRandomValues: a => require('crypto').getRandomValues(a) },
    btoa: s => Buffer.from(s, 'binary').toString('base64'),
    atob: s => Buffer.from(s, 'base64').toString('binary'),
    Promise,
    URL, URLSearchParams,
  };
  if (!opts.noFetch) {
    win.fetch = function (endpoint, init) {
      const body = JSON.parse(init.body);
      apiCalls.push({ endpoint, body, init });
      const p = Promise.resolve(opts.api(body)).then(r => {
        if (!r) throw new TypeError('Failed to fetch');
        return { status: r.status, json: async () => r.data };
      });
      pending.push(p.catch(() => {}));
      return p;
    };
  }
  win.window = win;
  const timers = [];
  const ctx = vm.createContext({
    window: win, URL, URLSearchParams, JSON, Date: opts.Date || Date, Object, Array, Number, String,
    Math, Uint8Array, encodeURIComponent, decodeURIComponent,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
  });
  vm.runInContext(ATTRIBUTION_SRC, ctx);
  async function settle() {
    // let fetch chains finish, then run retry timers (not the 5 s request timeout) once
    for (let round = 0; round < 5; round++) {
      await Promise.all(pending.splice(0));
      await new Promise(r => setImmediate(r));
      const due = timers.splice(0).filter(t => t.ms < 5000);
      due.forEach(t => t.fn());
      if (!due.length && !pending.length) break;
    }
  }
  return { win, apiCalls, replaced, settle, url: () => location.pathname + location.search + location.hash };
}

module.exports = { fakeUpstash, fakeRes, makeBrowser, loadPage, INSTAGRAM_UA };
