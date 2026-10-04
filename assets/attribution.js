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

   Nothing is fabricated: no fbclid/fbc/fbp is produced unless it came from
   the URL or Meta's own cookies. Every storage/cookie access is guarded, so
   blocked storage or cookies can never break the page or the lead form.

   window.zxAttribution() returns the merged values ({} on any failure).
   ───────────────────────────────────────────────────────────── */
(function (w) {
  'use strict';

  var RETENTION_MS = 90 * 24 * 60 * 60 * 1000;         // latest-touch & fbc retention: 90 days
  var UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'utm_id'];
  var SET_KEYS = UTM_KEYS.concat(['fbclid', 'gclid']);

  var RE_CLICK_ID = /^[\w-]{10,500}$/;                 // fbclid / gclid
  var RE_FBC = /^fb\.[0-2]\.\d{13}\.[\w-]{10,500}$/;
  var RE_FBP = /^fb\.[0-2]\.\d{13}\.\d{5,30}$/;

  function validFbc(v) { return typeof v === 'string' && RE_FBC.test(v); }
  function validFbp(v) { return typeof v === 'string' && RE_FBP.test(v); }
  function validClickId(v) { return typeof v === 'string' && RE_CLICK_ID.test(v); }
  function fbcTime(v) { return Number(v.split('.')[2]); }
  function fbcClickId(v) { return v.split('.').slice(3).join('.'); }
  // latest touch / stored click: 90-day retention
  function fresh(rec) { return !!rec && typeof rec.ts === 'number' && Date.now() - rec.ts < RETENTION_MS; }
  // first touch: permanent retention — valid structure never expires (no 90-day limit)
  function validFt(rec) { return !!rec && typeof rec.ts === 'number'; }
  // valid format AND embedded click time no older than 90 days
  function usableFbc(v) { return validFbc(v) && Date.now() - fbcTime(v) < RETENTION_MS; }

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

  /* ── capture on landing ── */
  var current = readUrl();          // this page's attribution, kept in memory even if storage fails
  var currentFbc = null;            // {fbc, fbclid, ts} for a click seen on this page

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

    // Meta click → fbc stamped with the time this fbclid was first captured
    if (current.fbclid) {
      var stored = load('zx_fbc');
      if (fresh(stored) && stored.fbclid === current.fbclid && usableFbc(stored.fbc)) {
        currentFbc = stored;                                   // same click seen again: keep original
      } else {
        var metaFbc = cookie('_fbc');
        var fbc = (usableFbc(metaFbc) && fbcClickId(metaFbc) === current.fbclid)
          ? metaFbc                                            // Meta already created one for this click
          : 'fb.1.' + now + '.' + current.fbclid;              // first capture time, not submit time
        currentFbc = { fbc: fbc, fbclid: current.fbclid, ts: now };
        save('zx_fbc', currentFbc);
      }
    }
  })();

  /* ── merged view for the lead form ── */
  w.zxAttribution = function () {
    try {
      var ft = load('zx_ft'), lt = load('zx_lt');
      if (!validFt(ft)) ft = null;
      if (!fresh(lt)) lt = null;

      var out = {};

      // 1. Current UTM parameters (only when present in current visit)
      UTM_KEYS.forEach(function (k) {
        if (current[k]) out[k] = current[k];
      });

      // 2. Current Google Click (only when gclid is present in current visit)
      if (current.gclid) {
        out.gclid = current.gclid;
      }

      // 3. Current Meta Click (only when fbclid is genuinely present on current visit)
      // Never blindly attach an old/stale fbc to an unrelated direct or Google visit.
      if (current.fbclid && currentFbc && usableFbc(currentFbc.fbc)) {
        var metaFbc = cookie('_fbc');
        var fbc = (usableFbc(metaFbc) && fbcClickId(metaFbc) === current.fbclid)
          ? metaFbc
          : currentFbc.fbc;
        out.fbc = fbc;
        out.fbclid = current.fbclid;
      }

      // 4. Browser identifier (_fbp cookie continues normally)
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
