/* ─────────────────────────────────────────────────────────────
   Zyvex Tech — persistent first-touch / latest-touch attribution.

   Loaded on every page of the journey (landing pages, portfolio,
   case studies) so a Meta click is remembered even if the visitor
   browses around or comes back later before submitting the form.

   Storage (localStorage, first-party):
     zx_ft   first touch   — written once; permanent retention (never expires while valid)
     zx_lt   latest touch  — 90-day retention; replaced when a different attribution set arrives
     zx_mj   CURRENT META JOURNEY {v, src:"meta", ts, fbc, fbclid, u} — the only source of the
             fbc/fbclid the form sends. Started by a Meta click (fbclid in the URL, or a click
             redeemed through zx_hid), it survives reloads and navigation between our own pages and
             tabs, and ends after 1 hour or at the next entry that is not a Meta click
             (typed URL, bookmark, external link, search). ft/lt are history only; they never
             decide whether a visitor is on a Meta journey.

   Cross-browser handoff (zx_hid, api/attribution-handoff.js):
     zx_hid  random 256-bit handle (crypto.getRandomValues) an in-app browser (WebView A)
             registers with the backend for its Meta click, then adds to its address bar
             with history.replaceState once registration succeeded. The backend keeps the
             click for 5 minutes from registration (Upstash Redis, never extended). If an
             external browser (Browser B) opens the page with that handle and has no Meta
             click of its own in the URL, it redeems the handle once (atomic read-and-delete),
             continues the same Meta journey with the original fbc and time, and strips
             zx_hid from the address bar. fbp is never carried: Browser B uses its own _fbp.
             zx_hid is never sent to Zoho or Meta as an attribution value.
     zx_mc   retired URL carrier; now stripped and ignored.

   Nothing is fabricated: no fbclid/fbc/fbp is produced unless it came from
   the URL, a valid unexpired zx_hid handoff record, or Meta's own cookies. Every
   storage/cookie access is guarded, so blocked storage or cookies can never
   break the page or the lead form.

   window.zxAttribution() returns the merged values ({} on any failure).
   ───────────────────────────────────────────────────────────── */
(function (w) {
  'use strict';

  var RETENTION_MS        = 90 * 24 * 60 * 60 * 1000; // latest-touch & fbc retention: 90 days
  var CARRIER_RETENTION_MS = 60 * 60 * 1000;           // handoff only for clicks under 1 hour old
  var JOURNEY_MS          = CARRIER_RETENTION_MS;      // Meta journey: 1 hour from the click, never extended
  var CLOCK_SKEW_MS       = 5 * 60 * 1000;             // tolerated clock drift on a stored timestamp
  var JOURNEY_KEY         = 'zx_mj';
  var HANDOFF_PARAM       = 'zx_hid';
  var HANDOFF_KEY         = 'zx_hd';                   // this browser's own registration {hid, fbclid, exp}
  var HANDOFF_URL         = '/api/attribution-handoff/';
  var HANDOFF_TTL_MS      = 5 * 60 * 1000;             // backend record lifetime, from registration
  var HANDOFF_MARGIN_MS   = 30 * 1000;                 // stop advertising a handle this close to expiry
  var HANDOFF_TIMEOUT_MS  = 5000;

  var UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'utm_id'];
  var SET_KEYS = UTM_KEYS.concat(['fbclid', 'gclid']);

  var RE_CLICK_ID = /^[\w-]{10,500}$/;                 // fbclid / gclid
  var RE_FBC      = /^fb\.[0-2]\.\d{13}\.[\w-]{10,500}$/;
  var RE_FBP      = /^fb\.[0-2]\.\d{13}\.\d{5,30}$/;
  var RE_HID      = /^[A-Za-z0-9_-]{43}$/;            // zx_hid: 32 random bytes, Base64URL

  function validFbc(v)     { return typeof v === 'string' && RE_FBC.test(v); }
  function validFbp(v)     { return typeof v === 'string' && RE_FBP.test(v); }
  function validClickId(v) { return typeof v === 'string' && RE_CLICK_ID.test(v); }
  function fbcTime(v)      { return Number(v.split('.')[2]); }
  function fbcClickId(v)   { return v.split('.').slice(3).join('.'); }
  // latest touch / stored click: 90-day retention
  function fresh(rec)      { return !!rec && typeof rec.ts === 'number' && Date.now() - rec.ts < RETENTION_MS; }
  // first touch: permanent retention — valid structure never expires (no 90-day limit)
  function validFt(rec)    { return !!rec && typeof rec.ts === 'number'; }
  // valid format AND embedded click time no older than 90 days
  function usableFbc(v)    { return validFbc(v) && Date.now() - fbcTime(v) < RETENTION_MS; }

  // Handoff eligibility: the zx_mj journey record must be valid and strictly < 1 hour old.
  // Absolute 1-hour rule: both stored capture time AND embedded click time must be < 1 hour.
  function carrierFresh(rec) {
    if (!rec || typeof rec !== 'object') return false;
    if (!validClickId(rec.fbclid)) return false;
    if (!validFbc(rec.fbc)) return false;
    if (fbcClickId(rec.fbc) !== rec.fbclid) return false;
    if (typeof rec.ts !== 'number') return false;
    var now = Date.now();
    return (now - rec.ts < CARRIER_RETENTION_MS) && (now - fbcTime(rec.fbc) < CARRIER_RETENTION_MS);
  }

  function cleanText(v) {
    if (typeof v !== 'string') return '';
    return v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 200);
  }

  /* ── guarded storage / cookies ── */
  function load(key) {
    try {
      var raw = w.localStorage.getItem(key);
      var rec = raw ? JSON.parse(raw) : null;
      return rec && typeof rec === 'object' ? rec : null;
    } catch (e) { return null; }
  }
  function save(key, rec) {
    try { w.localStorage.setItem(key, JSON.stringify(rec)); } catch (e) { /* storage unavailable */ }
  }
  function cookie(name) {
    try {
      var doc = w.document || document;
      var m = doc.cookie.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
      return m ? decodeURIComponent(m[1]) : '';
    } catch (e) { return ''; }
  }

  function remove(key) {
    try { w.localStorage.removeItem(key); } catch (e) { /* storage unavailable */ }
  }

  /* ── Meta journey ── */
  // Valid = Meta-sourced, not ended, consistent click id / fbc, and started less than 1 hour ago.
  function validJourney(j) {
    if (!j || typeof j !== 'object' || j.src !== 'meta' || j.ended) return false;
    if (!validClickId(j.fbclid) || !usableFbc(j.fbc) || fbcClickId(j.fbc) !== j.fbclid) return false;
    if (typeof j.ts !== 'number') return false;
    var age = Date.now() - j.ts;
    return age > -CLOCK_SKEW_MS && age < JOURNEY_MS;
  }

  // How this page was reached: 'navigate' | 'reload' | 'back_forward'.
  function navType() {
    try {
      var e = w.performance.getEntriesByType('navigation')[0];
      if (e && e.type) return e.type;
    } catch (err) { /* fall through */ }
    try {
      var t = w.performance.navigation.type;
      return t === 1 ? 'reload' : t === 2 ? 'back_forward' : 'navigate';
    } catch (err) { return 'navigate'; }
  }
  function internalReferrer() {
    try {
      var r = (w.document || document).referrer;
      return !!r && new URL(r).origin === w.location.origin;
    } catch (e) { return false; }
  }
  // A fresh arrival from outside the site (typed URL, bookmark, external link, search).
  // Reloads, back/forward and clicks between our own pages are the same journey.
  function isNewEntry() {
    var t = navType();
    if (t === 'reload' || t === 'back_forward') return false;
    return !internalReferrer();
  }

  /* ── read this page's URL ── */
  function readUrl() {
    var out = {};
    try {
      var sp = new URLSearchParams(w.location.search);
      UTM_KEYS.forEach(function (k) { var v = cleanText(sp.get(k)); if (v) out[k] = v; });
      var fbclid = sp.get('fbclid');
      if (validClickId(fbclid)) out.fbclid = fbclid;          // malformed → ignored
      var gclid = sp.get('gclid');
      if (validClickId(gclid)) out.gclid = gclid;
    } catch (e) { /* no URLSearchParams / bad URL */ }
    return out;
  }

  function sameSet(a, b) {
    if (!a || !b) return false;
    for (var i = 0; i < SET_KEYS.length; i++) {
      if ((a[SET_KEYS[i]] || '') !== (b[SET_KEYS[i]] || '')) return false;
    }
    return true;
  }

  /* ── in-app browser / WebView detection ── */
  // Used to decide whether to register and maintain zx_hid in the address bar.
  // The receiving Browser B does NOT need to pass this check to redeem zx_hid.
  function isInAppBrowser() {
    try {
      var ua = (w.navigator && w.navigator.userAgent) ? String(w.navigator.userAgent) : '';
      // Common Meta (Instagram, Facebook) and other app WebView signals
      return /FBAN|FBAV|Instagram|FB_IAB|FBIOS|FBANDROID|Messenger|Line|Twitter|TikTok|Snapchat|LinkedIn|Viber|WeChat|MicroMessenger|KAKAOTALK/i.test(ua) ||
             // Fallback: generic Android or iOS WebView signals (wv = WebView flag in Chrome for Android)
             /\bwv\b/.test(ua) ||
             (ua.indexOf('Android') > -1 && ua.indexOf('Version/') > -1 && ua.indexOf('Chrome') === -1);
    } catch (e) { return false; }
  }

  /* ── URL parameters (history.replaceState, never a reload) ── */
  // Rebuilds the query string keeping every other parameter, the path and the hash.
  function setParam(name, value) {
    try {
      var loc = w.location, h = w.history;
      if (!h || !h.replaceState) return false;
      var kept = String(loc.search || '').replace(/^\?/, '').split('&').filter(function (p) {
        return p && p.split('=')[0] !== name;
      });
      if (value) kept.push(name + '=' + encodeURIComponent(value));
      var qs = kept.length ? '?' + kept.join('&') : '';
      h.replaceState(h.state, '', loc.pathname + qs + (loc.hash || ''));
      return true;
    } catch (e) { return false; }   // history API unavailable — attribution still works
  }
  function stripParam(name) { return setParam(name, ''); }
  function urlParam(name) {
    try { return new URLSearchParams(w.location.search).get(name) || ''; } catch (e) { return ''; }
  }

  /* ── zx_hid handoff: random handle + backend calls ── */
  // 32 bytes from the browser's CSPRNG, Base64URL (43 chars). No CSPRNG → no handoff.
  function newHid() {
    try {
      var c = w.crypto || w.msCrypto;
      if (!c || !c.getRandomValues) return '';
      var b = new Uint8Array(32);
      c.getRandomValues(b);
      var s = '';
      for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
      var out = w.btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      return RE_HID.test(out) ? out : '';
    } catch (e) { return ''; }
  }
  function canCallApi() {
    return typeof w.fetch === 'function' && typeof w.Promise === 'function';
  }
  // POST to the handoff endpoint. Resolves {status, data}, or null on a network error/timeout.
  function handoffApi(body) {
    return new w.Promise(function (resolve) {
      var done = false;
      function finish(v) { if (!done) { done = true; resolve(v); } }
      setTimeout(function () { finish(null); }, HANDOFF_TIMEOUT_MS);
      try {
        w.fetch(HANDOFF_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          credentials: 'omit',
          cache: 'no-store'
        }).then(function (r) {
          return r.json().then(function (d) { return d; }, function () { return null; })
            .then(function (d) { finish({ status: r.status, data: d }); });
        }, function () { finish(null); });
      } catch (e) { finish(null); }
    });
  }
  // A click returned by the backend: same shape and consistency rules as a local click.
  function validRecovered(d) {
    return !!d && d.ok === true && validClickId(d.fbclid) && validFbc(d.fbc) &&
      fbcClickId(d.fbc) === d.fbclid && typeof d.ts === 'number';
  }
  // This browser's own registration {hid, fbclid, exp}, if any.
  function ownHandoff() {
    var h = load(HANDOFF_KEY);
    return h && RE_HID.test(h.hid || '') && validClickId(h.fbclid) && typeof h.exp === 'number' ? h : null;
  }

  /* ── read this page ── */
  var inApp     = isInAppBrowser();
  var current   = readUrl();              // this page's URL attribution (UTM/fbclid/gclid)
  var urlFbclid = current.fbclid || '';   // a Meta click in THIS address bar

  // zx_mc (retired URL carrier) is no longer trusted: a click crosses browsers only
  // through a registered zx_hid handoff record.
  if (urlParam('zx_mc')) stripParam('zx_mc');

  // zx_hid in the URL is either this browser's own handle (an in-app browser reloading or
  // re-showing it) or one handed over from another browser, which we try to redeem.
  var incomingHid = '';
  (function readHandoffParam() {
    var hid = urlParam(HANDOFF_PARAM);
    if (!hid) return;
    if (!RE_HID.test(hid)) { stripParam(HANDOFF_PARAM); return; }      // malformed
    var own = ownHandoff();
    if (own && own.hid === hid) return;                                 // ours: maintained below
    // A Meta click in this URL is current attribution and wins; the handle is not needed.
    if (urlFbclid || !canCallApi()) { stripParam(HANDOFF_PARAM); return; }
    incomingHid = hid;
  })();

  /* ── Meta journey: start, keep, or end ── */
  // One record (zx_mj) answers "did this visitor come from a Meta ad?":
  //   Meta click on this page (URL fbclid, or a click redeemed via zx_hid) → start / keep the journey
  //   no click, but reload / back / click from our own page                → keep the journey
  //   no click, fresh arrival from outside the site                        → end it (stale protection)
  // Nothing is fabricated: fbc comes from the click id, never from IP, user agent or timing.
  var journey = null;
  remove('zx_fbc');                          // retired store, superseded by zx_mj

  // Starts or keeps the journey for a click. Returns true when the click was handled
  // (journey set, or deliberately not restarted), false to fall back to the no-click rules.
  function startJourney(click) {
    var now = Date.now();
    var raw = load(JOURNEY_KEY);               // last journey record, active or not
    var stored = validJourney(raw) ? raw : null;
    if (stored && stored.fbclid === click.fbclid) { journey = stored; return true; } // same click seen again: keep original
    // A click starts at most one journey: once it has expired or ended, reloading or
    // reopening that old ad URL does not start another. Only a different Meta click does.
    if (raw && raw.fbclid === click.fbclid) return true;
    var fbc = click.fbc;
    if (!fbc) {
      var metaFbc = cookie('_fbc');
      fbc = (usableFbc(metaFbc) && fbcClickId(metaFbc) === click.fbclid)
        ? metaFbc                                            // Meta already created one for this click
        : 'fb.1.' + now + '.' + click.fbclid;                // first capture time, not submit time
    }
    var u = {};
    UTM_KEYS.forEach(function (k) { if (current[k]) u[k] = current[k]; });
    var rec = { v: 1, src: 'meta', ts: click.ts, fbc: fbc, fbclid: click.fbclid, u: u };
    if (validJourney(rec)) { journey = rec; save(JOURNEY_KEY, rec); return true; }
    return false;
  }
  function noClickJourney() {
    var raw = load(JOURNEY_KEY);
    var stored = validJourney(raw) ? raw : null;
    if (stored && !isNewEntry()) { journey = stored; return; }
    // New entry from outside the site: the journey is over. The record is kept (marked
    // ended) rather than deleted, so history stays and the old click cannot be restarted.
    if (stored) save(JOURNEY_KEY, Object.assign({}, stored, { ended: true }));
  }

  /* ── first / latest touch ── */
  // ts: when this touch happened; a redeemed click keeps its original time.
  function capture(ts) {
    if (!Object.keys(current).length) return;
    var now = typeof ts === 'number' ? ts : Date.now();
    var path = '';
    try { path = String(w.location.pathname || '').slice(0, 200); } catch (e) {}

    var touch = { ts: now, landing: path };
    SET_KEYS.forEach(function (k) { if (current[k]) touch[k] = current[k]; });

    // latest touch: replace only when a different attribution set arrives,
    // so a reload of the same ad URL keeps the original landing time
    var lt = load('zx_lt');
    if (!(fresh(lt) && sameSet(lt, touch))) save('zx_lt', touch);

    // first touch: write once; permanent retention (never expires while valid)
    if (!validFt(load('zx_ft'))) save('zx_ft', touch);
  }

  /* ── zx_hid maintenance (Browser A — in-app browser only) ── */
  // While a Meta journey is under 1 hour old, keep a registered handle in the address bar
  // so "Open in Chrome/Safari" hands it over. One registration covers every page for its
  // 5-minute lifetime; a new one is made only after it lapses. Links are not rewritten.
  function maintainHandoff() {
    if (!inApp) return;                    // normal Chrome/Safari/desktop: never register
    var inUrl = urlParam(HANDOFF_PARAM);
    var j = (!current.gclid && carrierFresh(journey)) ? journey : null;
    if (!j) { if (inUrl) stripParam(HANDOFF_PARAM); return; }

    var now = Date.now();
    var own = ownHandoff();
    if (own && own.fbclid === j.fbclid && own.exp - now > HANDOFF_MARGIN_MS) {
      if (inUrl !== own.hid) setParam(HANDOFF_PARAM, own.hid);
      return;
    }
    if (inUrl) stripParam(HANDOFF_PARAM);  // lapsed handle: never advertise it
    if (!canCallApi()) return;
    var hid = newHid();
    if (!hid) return;

    // The click this browser would report: Meta's own _fbc for the same click, else ours.
    var metaFbc = cookie('_fbc');
    var fbc = (usableFbc(metaFbc) && fbcClickId(metaFbc) === j.fbclid) ? metaFbc : j.fbc;
    var body = { action: 'register', hid: hid, fbclid: j.fbclid, fbc: fbc, ts: j.ts, u: j.u || {} };
    function attempt(left) {
      handoffApi(body).then(function (r) {
        if (r && r.status === 200 && r.data && r.data.ok) {
          // Only now is the carrier real: remember it and put it in the address bar.
          save(HANDOFF_KEY, { hid: hid, fbclid: j.fbclid, exp: now + HANDOFF_TTL_MS });
          setParam(HANDOFF_PARAM, hid);
          return;
        }
        // Network error or storage outage: retry once with the SAME handle (the server
        // treats an identical re-registration as success, so no second record is made).
        if (left > 0 && (!r || r.status >= 500)) setTimeout(function () { attempt(left - 1); }, 1000);
      });
    }
    attempt(1);
  }

  /* ── run ── */
  if (!incomingHid) {
    if (!(urlFbclid && startJourney({ fbclid: urlFbclid, ts: Date.now(), fbc: '' }))) noClickJourney();
    capture();
    maintainHandoff();
  } else {
    // Browser B: redeem the handle before deciding the journey or writing touches, so a
    // handed-over click is recorded as the Meta touch it is. Until then a journey this
    // browser already had stays readable.
    (function () { var s = load(JOURNEY_KEY); if (validJourney(s)) journey = s; })();
    handoffApi({ action: 'retrieve', hid: incomingHid }).then(function (r) {
      var d = r && r.status === 200 ? r.data : null;
      var touchTs;
      if (validRecovered(d)) {
        var before = Object.assign({}, current);
        current.fbclid = d.fbclid;
        var ru = d.u && typeof d.u === 'object' ? d.u : {};
        UTM_KEYS.forEach(function (k) {
          var v = cleanText(ru[k]);
          if (!current[k] && v) current[k] = v;
        });
        journey = null;
        if (startJourney({ fbclid: d.fbclid, ts: d.ts, fbc: d.fbc })) {
          touchTs = d.ts;
        } else {
          noClickJourney();
        }
        if (!journey || journey.fbclid !== d.fbclid) {
          // Not usable here (already used or expired in this browser): drop it entirely.
          current = before;
          touchTs = undefined;
        }
      } else {
        journey = null;
        noClickJourney();
      }
      // Remove the handle once the answer is final; keep it after a network error or
      // storage outage so a reload can try again (the record was not consumed).
      if (r && r.status < 500) stripParam(HANDOFF_PARAM);
      capture(touchTs);
      maintainHandoff();
    });
  }

  // The journey to report right now: re-checked on every call so an expired one is never sent.
  function activeJourney() {
    var s = load(JOURNEY_KEY);
    if (validJourney(s)) return s;
    return validJourney(journey) ? journey : null;   // in-memory copy when storage is blocked
  }

  /* ── merged view for the lead form ── */
  w.zxAttribution = function () {
    try {
      var ft = load('zx_ft'), lt = load('zx_lt');
      if (!validFt(ft)) ft = null;
      if (!fresh(lt)) lt = null;

      var j = activeJourney();
      var out = {};

      // 1. UTM parameters: this page's, else the ones the Meta journey arrived with
      UTM_KEYS.forEach(function (k) {
        var v = current[k] || (j && j.u && cleanText(j.u[k]));
        if (v) out[k] = v;
      });

      // 2. Current Google Click (only when gclid is present in current visit)
      if (current.gclid) {
        out.gclid = current.gclid;
      }

      // 3. Meta click: only while a Meta journey is active. A visitor with no active
      //    journey (direct, bookmark, search, other referral) never gets an fbc/fbclid.
      if (j) {
        var metaFbc = cookie('_fbc');
        out.fbc    = (usableFbc(metaFbc) && fbcClickId(metaFbc) === j.fbclid) ? metaFbc : j.fbc;
        out.fbclid = j.fbclid;
        // The explicit "this conversion is on an active Meta journey" signal the server
        // uses for the CRM source. Age, not a timestamp, so client clock drift is harmless.
        out.meta_journey = { source: 'meta', age_ms: Math.max(0, Date.now() - j.ts) };
      }

      // 4. Browser identifier (_fbp cookie — Browser B uses its own, not carried)
      var fbp = cookie('_fbp');
      if (validFbp(fbp)) out.fbp = fbp;

      // 5. Preserved multi-touch history (never used to decide the CRM source)
      if (ft) out.first_touch = ft;
      if (lt) out.latest_touch = lt;

      return out;
    } catch (e) {
      return {};
    }
  };
})(window);
