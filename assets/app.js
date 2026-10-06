/* ─────────────────────────────────────────────────────────────
   Zyvex Tech — case-study pages (in.zyvextech.co/works/...)
   Shared behaviour: Meta Pixel PageView, scroll reveal, founder video.

   Lead capture is NOT handled here. The only lead forms live in
   /index.html and /shopify/index.html, which send the Pixel event and
   POST /api/submit-lead with the same event_id (see assets/attribution.js).

   PIXEL_ID is NOT stored here. It is fetched at runtime from
   /api/config so it only needs to be set in Vercel's env vars
   (META_PIXEL_ID) and never hard-coded in source files.
   ───────────────────────────────────────────────────────────── */
var CONFIG = {
  /* Founder video. Put an mp4 in /assets and point at it, e.g.
     "/assets/founder.mp4". Leave "" to keep the placeholder. */
  FOUNDER_VIDEO: "",
  FOUNDER_POSTER: ""
};

/* ── Meta Pixel ───────────────────────────────────────────── */

/** pixelId is fetched from /api/config at runtime — never hard-coded. */
var _pixelId = '';

function initPixel(pixelId) {
  if (!pixelId) return;
  _pixelId = pixelId;
  /* eslint-disable */
  !function (f, b, e, v, n, t, s) {
    if (f.fbq) return; n = f.fbq = function () {
      n.callMethod ?
        n.callMethod.apply(n, arguments) : n.queue.push(arguments)
    }; if (!f._fbq) f._fbq = n;
    n.push = n; n.loaded = !0; n.version = '2.0'; n.queue = []; t = b.createElement(e); t.async = !0;
    t.src = v; s = b.getElementsByTagName(e)[0]; s.parentNode.insertBefore(t, s)
  }
    (window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');
  /* eslint-enable */
  window.fbq('init', _pixelId);
  window.fbq('track', 'PageView');
}

/* ── Founder video ────────────────────────────────────────── */
function initFounderVideo() {
  var v = document.getElementById('founder-video');
  var empty = document.getElementById('video-empty');
  if (!v) return;
  if (!CONFIG.FOUNDER_VIDEO) { return; }   /* placeholder stays put */
  v.src = CONFIG.FOUNDER_VIDEO;
  if (CONFIG.FOUNDER_POSTER) v.poster = CONFIG.FOUNDER_POSTER;
  if (empty) empty.style.display = 'none';
}

/* ── Scroll reveal ────────────────────────────────────────── */
function initReveal() {
  var els = document.querySelectorAll('.rv');
  if (!els.length) return;
  if (!('IntersectionObserver' in window)) {
    Array.prototype.forEach.call(els, function (el) { el.classList.add('in'); });
    return;
  }
  var obs = new IntersectionObserver(function (entries) {
    entries.forEach(function (en) {
      if (en.isIntersecting) { en.target.classList.add('in'); obs.unobserve(en.target); }
    });
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
  Array.prototype.forEach.call(els, function (el) { obs.observe(el); });
}

document.addEventListener('DOMContentLoaded', function () {
  // Fetch Pixel ID from server env var — never stored in source code.
  fetch('/api/config')
    .then(function (r) { return r.ok ? r.json() : {}; })
    .then(function (cfg) { initPixel(cfg.pixelId || ''); })
    .catch(function () { /* silently skip tracking if endpoint unreachable */ });

  initFounderVideo();
  initReveal();
});
