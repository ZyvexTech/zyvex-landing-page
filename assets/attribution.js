/* ─────────────────────────────────────────────────────────────
   Zyvex Tech — persistent first-touch / latest-touch attribution.

   Loaded on every page of the journey (landing pages, portfolio,
   case studies) so a Meta click is remembered even if the visitor
   browses around or comes back later before submitting the form.

   Storage (localStorage, first-party):
     zx_ft   first touch   — written once; permanent retention (never expires while valid)
     zx_lt   latest touch  — 90-day retention; replaced when a different attribution set arrives
     zx_fbc  latest Meta click {fbc, fbclid, ts} — 90-day retention; fbc built from the time
             the fbclid was FIRST captured, or Meta's own _fbc for that click

   Cross-browser carrier (URL parameter, 1-hour lifetime):
     zx_mc   compact Base64URL payload carrying Meta click attribution from an in-app
             browser (WebView A) to an external browser (Browser B). Maintained in the
             address bar of an in-app browser across internal page exploration within 1
             hour of the click. Consumed once by the receiving external browser, then
             immediately stripped from the address bar. Never propagated further.

   Nothing is fabricated: no fbclid/fbc/fbp is produced unless it came from
   the URL, a valid unexpired zx_mc carrier, or Meta's own cookies. Every
   storage/cookie access is guarded, so blocked storage or cookies can never
   break the page or the lead form.

   window.zxAttribution() returns the merged values ({} on any failure).
   ───────────────────────────────────────────────────────────── */
(function (w) {
  'use strict';

  var RETENTION_MS        = 90 * 24 * 60 * 60 * 1000; // latest-touch & fbc retention: 90 days
  var CARRIER_RETENTION_MS = 60 * 60 * 1000;           // zx_mc carrier lifetime: 1 hour

  var UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'utm_id'];
  var SET_KEYS = UTM_KEYS.concat(['fbclid', 'gclid']);

  var RE_CLICK_ID = /^[\w-]{10,500}$/;                 // fbclid / gclid
  var RE_FBC      = /^fb\.[0-2]\.\d{13}\.[\w-]{10,500}$/;
  var RE_FBP      = /^fb\.[0-2]\.\d{13}\.\d{5,30}$/;

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

  // Carrier eligibility: stored zx_fbc record must be valid and strictly < 1 hour old.
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
  // Used to decide whether to generate and maintain zx_mc in the address bar.
  // The receiving Browser B does NOT need to pass this check to consume zx_mc.
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

  /* ── zx_mc carrier: Base64URL encode / decode ── */
  function b64urlEncode(str) {
    try {
      return w.btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    } catch (e) { return ''; }
  }
  function b64urlDecode(str) {
    try {
      var s = String(str).replace(/-/g, '+').replace(/_/g, '/');
      var pad = s.length % 4;
      if (pad === 2) s += '==';
      else if (pad === 3) s += '=';
      return w.atob(s);
    } catch (e) { return ''; }
  }

  /* ── zx_mc: read and validate the carrier from the current URL ── */
  // Returns a plain-object payload when valid; null otherwise.
  // Validity requires: correct version, valid fbclid, numeric timestamps,
  // and carrier age strictly less than CARRIER_RETENTION_MS (1 hour).
  function readCarrier() {
    try {
      var raw = new URLSearchParams(w.location.search).get('zx_mc');
      if (!raw) return null;
      var decoded = b64urlDecode(raw);
      if (!decoded) return null;
      var p = JSON.parse(decoded);
      if (!p || typeof p !== 'object') return null;
      if (p.v !== 1) return null;                              // unknown version → ignore
      if (!validClickId(p.c)) return null;                     // invalid fbclid
      if (typeof p.t !== 'number' || typeof p.ot !== 'number') return null;
      var now = Date.now();
      if (now - p.t >= CARRIER_RETENTION_MS || now - p.ot >= CARRIER_RETENTION_MS) return null; // expired (>= 1 hour)
      return p;                                                // valid payload
    } catch (e) { return null; }
  }

  /* ── zx_mc: build the carrier payload from a known Meta click ── */
  // Crucial: carrierCreatedTs is the ORIGINAL click/capture timestamp (never Date.now() on navigation),
  // ensuring the 1-hour window is absolute and cannot be extended by navigating.
  function buildCarrier(fbclid, originalClickTs, carrierCreatedTs, utmMap) {
    try {
      var payload = { v: 1, c: fbclid, t: carrierCreatedTs, ot: originalClickTs };
      var u = {};
      if (utmMap) {
        if (utmMap.utm_source   || utmMap.s)  u.s  = String(utmMap.utm_source   || utmMap.s).slice(0, 100);
        if (utmMap.utm_medium   || utmMap.m)  u.m  = String(utmMap.utm_medium   || utmMap.m).slice(0, 100);
        if (utmMap.utm_campaign || utmMap.c)  u.c  = String(utmMap.utm_campaign || utmMap.c).slice(0, 100);
        if (utmMap.utm_content  || utmMap.ct) u.ct = String(utmMap.utm_content  || utmMap.ct).slice(0, 100);
        if (utmMap.utm_term     || utmMap.tr) u.tr = String(utmMap.utm_term     || utmMap.tr).slice(0, 100);
        if (utmMap.utm_id       || utmMap.i)  u.i  = String(utmMap.utm_id       || utmMap.i).slice(0, 100);
      }
      if (Object.keys(u).length) payload.u = u;
      return b64urlEncode(JSON.stringify(payload));
    } catch (e) { return ''; }
  }

  /* ── zx_mc: write the carrier into the current URL (in-app browser only) ── */
  function writeCarrier(encoded) {
    try {
      if (!encoded) return;
      var loc = w.location, h = w.history;
      if (!h || !h.replaceState) return;
      // If an identical carrier already exists in the URL, skip (idempotent)
      var existing = new URLSearchParams(loc.search).get('zx_mc');
      if (existing === encoded) return;
      // Rebuild query string: keep all existing params except zx_mc, then append new one
      var kept = String(loc.search || '').replace(/^\?/, '').split('&').filter(function (p) {
        return p && p.split('=')[0] !== 'zx_mc';
      });
      kept.push('zx_mc=' + encoded);
      h.replaceState(h.state, '', loc.pathname + '?' + kept.join('&') + (loc.hash || ''));
    } catch (e) { /* history API unavailable — attribution still works */ }
  }

  /* ── zx_mc: strip the carrier from the URL after consumption or expiration ── */
  function stripCarrier() {
    try {
      var loc = w.location, h = w.history;
      if (!h || !h.replaceState) return;
      var kept = String(loc.search || '').replace(/^\?/, '').split('&').filter(function (p) {
        return p && p.split('=')[0] !== 'zx_mc';
      });
      var qs = kept.length ? '?' + kept.join('&') : '';
      h.replaceState(h.state, '', loc.pathname + qs + (loc.hash || ''));
    } catch (e) { /* ignore */ }
  }

  /* ── capture on landing ── */
  var inApp           = isInAppBrowser();
  var current         = readUrl();          // this page's URL attribution (UTM/fbclid/gclid)
  var currentFbc      = null;               // {fbc, fbclid, ts} for the click active in this page
  var rawCarrier      = null;
  try { rawCarrier = new URLSearchParams(w.location.search).get('zx_mc'); } catch (e) {}

  var carrierPayload  = readCarrier();
  var carrierConsumed = false;

  // Clean up invalid or expired zx_mc from the address bar immediately
  if (rawCarrier && !carrierPayload) {
    stripCarrier();
  }

  // Handle valid zx_mc in the URL
  if (carrierPayload) {
    var carriedFbclid = carrierPayload.c;
    var carriedFbc    = 'fb.1.' + carrierPayload.ot + '.' + carriedFbclid;
    if (!current.fbclid) {
      current.fbclid = carriedFbclid;
    }
    // Restore campaign UTMs from carrier if not already in URL
    if (carrierPayload.u) {
      var umap = carrierPayload.u;
      if (!current.utm_source   && umap.s)  current.utm_source   = cleanText(umap.s);
      if (!current.utm_medium   && umap.m)  current.utm_medium   = cleanText(umap.m);
      if (!current.utm_campaign && umap.c)  current.utm_campaign = cleanText(umap.c);
      if (!current.utm_content  && umap.ct) current.utm_content  = cleanText(umap.ct);
      if (!current.utm_term     && umap.tr) current.utm_term     = cleanText(umap.tr);
      if (!current.utm_id       && umap.i)  current.utm_id       = cleanText(umap.i);
    }
    currentFbc = { fbc: carriedFbc, fbclid: carriedFbclid, ts: carrierPayload.ot };
    save('zx_fbc', currentFbc);

    if (!inApp) {
      // Browser B (external Chrome/Safari breakout):
      // Consume carrier, persist attribution, and immediately strip zx_mc from URL.
      carrierConsumed = true;
      stripCarrier();
    }
    // In Browser A (inApp === true), keep existing valid zx_mc in the URL without stripping
  }

  (function capture() {
    if (!Object.keys(current).length) return;
    var now = Date.now();
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

    // Meta click → fbc stamped with the time this fbclid was first captured.
    // If a carrier pre-set currentFbc (Browser B), skip re-derivation to preserve
    // the original click timestamp embedded in the carrier.
    if (current.fbclid && !currentFbc) {
      var stored = load('zx_fbc');
      if (fresh(stored) && stored.fbclid === current.fbclid && usableFbc(stored.fbc)) {
        currentFbc = stored;                                   // same click seen again: keep original
      } else {
        var metaFbc = cookie('_fbc');
        var fbc = (usableFbc(metaFbc) && fbcClickId(metaFbc) === current.fbclid)
          ? metaFbc                                            // Meta already created one for this click
          : 'fb.1.' + now + '.' + current.fbclid;              // first capture time, not submit time
        var u = {};
        UTM_KEYS.forEach(function (k) { if (current[k]) u[k] = current[k]; });
        currentFbc = { fbc: fbc, fbclid: current.fbclid, ts: now, u: u };
        save('zx_fbc', currentFbc);
      }
    }
  })();

  /* ── zx_mc maintenance (Browser A — in-app browser only) ── */
  // Maintains zx_mc in the address bar across internal page exploration inside an
  // in-app browser, so that whenever the user selects "Open in Chrome/Safari",
  // the external browser receives the current page URL with the attribution carrier attached.
  (function maybeMaintainCarrier() {
    if (!inApp) return;                    // normal Chrome/Safari/desktop: never maintain
    if (carrierConsumed) return;           // Browser B: never maintain
    if (current.gclid) return;             // Google click: do not generate Meta carrier

    // If current URL already contains a valid zx_mc, preserve it (do not regenerate or refresh ts)
    if (carrierPayload) return;

    // Check if an active, fresh Meta click exists in zx_fbc (< 1 hour old)
    var stored = currentFbc || load('zx_fbc');
    if (!carrierFresh(stored)) return;     // no click, or click >= 1 hour old: do NOT generate

    // Build carrier using the ORIGINAL click/capture timestamp (never Date.now())
    var originalClickTs  = fbcTime(stored.fbc);
    var carrierCreatedTs = stored.ts;     // original capture timestamp!
    var utmSource        = stored.u || current;
    var encoded = buildCarrier(stored.fbclid, originalClickTs, carrierCreatedTs, utmSource);
    if (encoded) writeCarrier(encoded);
  })();

  /* ── merged view for the lead form ── */
  w.zxAttribution = function () {
    try {
      var ft = load('zx_ft'), lt = load('zx_lt');
      if (!validFt(ft)) ft = null;
      if (!fresh(lt)) lt = null;

      var out = {};

      // 1. Current UTM parameters (only when present in current visit or recovered carrier)
      UTM_KEYS.forEach(function (k) {
        if (current[k]) out[k] = current[k];
      });

      // 2. Current Google Click (only when gclid is present in current visit)
      if (current.gclid) {
        out.gclid = current.gclid;
      }

      // 3. Current Meta Click — only when:
      //    (a) a genuine fbclid exists in current URL, OR
      //    (b) a valid unexpired zx_mc carrier was consumed this session.
      //    Never blindly attach an old/stale fbc to an unrelated direct or Google visit.
      if (current.fbclid && currentFbc && usableFbc(currentFbc.fbc)) {
        var metaFbc = cookie('_fbc');
        var fbc = (usableFbc(metaFbc) && fbcClickId(metaFbc) === current.fbclid)
          ? metaFbc
          : currentFbc.fbc;
        out.fbc    = fbc;
        out.fbclid = current.fbclid;
      }

      // 4. Browser identifier (_fbp cookie — Browser B uses its own, not carried)
      var fbp = cookie('_fbp');
      if (validFbp(fbp)) out.fbp = fbp;

      // 5. Preserved multi-touch history
      if (ft) out.first_touch = ft;
      if (lt) out.latest_touch = lt;

      return out;
    } catch (e) {
      return {};
    }
  };
})(window);
