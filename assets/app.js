/* ─────────────────────────────────────────────────────────────
   Zyvex Tech — India landing pages (in.zyvextech.co)
   Shared behaviour: lead form, webhook delivery, Meta Pixel.

   ── CONFIG ──────────────────────────────────────────────────
   PIXEL_ID is NOT stored here. It is fetched at runtime from
   /api/config so it only needs to be set in Vercel's env vars
   (META_PIXEL_ID) and never hard-coded in source files.
   ───────────────────────────────────────────────────────────── */
var CONFIG = {
  LEAD_WEBHOOK: '/api/submit-lead',

  /* Fallback inbox used only while LEAD_WEBHOOK is empty. */
  FALLBACK_EMAIL: "techzyvex@gmail.com",

  /* Founder video. Put an mp4 in /assets and point at it, e.g.
     "/assets/founder.mp4". Leave "" to keep the placeholder. */
  FOUNDER_VIDEO: "",
  FOUNDER_POSTER: ""
};

/* ── Lead value tiers ─────────────────────────────────────────
   The value sent with the Meta Lead event. These are the
   monthly fee (retainer) or the build fee (Shopify) in INR, so
   the algorithm optimises toward the enquiries actually worth
   having rather than treating every form fill alike.
   ───────────────────────────────────────────────────────────── */
var LEAD_VALUES = {
  /* retainer, keyed by the prospect's stated monthly marketing budget.
     The page states a floor of INR 25,000, so every option qualifies. */
  "retainer:25k-50k": 25000,
  "retainer:50k-1l": 30000,
  "retainer:1l-3l": 40000,
  "retainer:3l-plus": 40000,
  "retainer:1l-5l": 40000,
  "retainer:5l-20l": 40000,
  "retainer:20l-plus": 40000,
  /* one-time Shopify build, keyed by stated budget */
  "shopify:under-15k": 0,
  "shopify:15k-30k": 20000,
  "shopify:30k-50k": 40000,
  "shopify:50k-1l": 70000,
  "shopify:1l-plus": 100000
};

/* Enquiries below the qualifying minimum are still captured, but
   they are sent with value 0 and flagged, so they neither train
   the algorithm nor clutter the qualified pipeline. */
function leadValue(form, tier) {
  var key = form + ":" + tier;
  return Object.prototype.hasOwnProperty.call(LEAD_VALUES, key) ? LEAD_VALUES[key] : 0;
}

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

function trackLead(payload) {
  if (!_pixelId || !window.fbq) return;
  window.fbq('track', 'Lead', {
    value: payload.lead_value,
    currency: 'INR',
    content_name: payload.form,
    content_category: payload.budget_tier
  }, { eventID: payload.event_id });
}

/* ── Delivery ─────────────────────────────────────────────────
   PAYLOAD CONTRACT — this JSON is POSTed to CONFIG.LEAD_WEBHOOK
   as application/json. Point a Zoho Flow incoming webhook at it
   and map the fields straight onto the CRM Lead:

   {
     "form":         "retainer" | "shopify",
     "name":         string,
     "email":        string,
     "phone":        string,
     "business":     string,   // business or brand name
     "website":      string,   // may be empty
     "budget_tier":  string,   // see LEAD_VALUES keys
     "budget_label": string,   // human-readable version of the above
     "message":      string,   // may be empty
     "lead_value":   number,   // INR, 0 = below qualifying minimum
     "qualified":    boolean,  // lead_value > 0
     "event_id":     string,   // dedupe key — send the same id from
                               // the server-side CAPI Lead event
     "source":       "in.zyvextech.co",
     "page":         string,   // pathname the form was submitted from
     "submitted_at": string    // ISO 8601
   }
   ───────────────────────────────────────────────────────────── */
function deliver(payload) {
  if (CONFIG.LEAD_WEBHOOK) {
    return fetch(CONFIG.LEAD_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (r) {
      if (!r.ok) throw new Error('webhook responded ' + r.status);
      return true;
    });
  }
  /* No webhook configured yet: hand the enquiry to the email client
     rather than dropping it. */
  var lines = [
    'Name: ' + payload.name,
    'Email: ' + payload.email,
    'Phone: ' + payload.phone,
    'Business: ' + payload.business,
    'Website: ' + (payload.website || 'not given'),
    'Budget: ' + payload.budget_label,
    '',
    payload.message || '(no message)',
    '',
    'Submitted from ' + payload.page + ' at ' + payload.submitted_at
  ].join('\n');
  var href = 'mailto:' + CONFIG.FALLBACK_EMAIL
    + '?subject=' + encodeURIComponent('Enquiry from ' + payload.business)
    + '&body=' + encodeURIComponent(lines);
  window.location.href = href;
  return Promise.resolve(false);
}

function uid() {
  return 'zx-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9);
}

/* ── Form ─────────────────────────────────────────────────── */
function initForm() {
  var form = document.getElementById('lead-form');
  if (!form) return;
  var kind = form.getAttribute('data-form');
  var done = document.getElementById('form-done');
  var note = document.getElementById('form-note');
  var btn = form.querySelector('.submit');

  var setInvalid = function (el, on) {
    var f = el.closest('.field');
    if (f) f.classList.toggle('invalid', on);
  };

  form.addEventListener('submit', function (e) {
    e.preventDefault();

    var required = ['name', 'email', 'phone', 'business', 'budget', 'message'];
    var bad = false;
    required.forEach(function (n) {
      var el = form.elements[n];
      var empty = !el.value.trim();
      var badEmail = n === 'email' && el.value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(el.value);
      var badPhone = n === 'phone' && el.value && el.value.replace(/\D/g, '').length < 10;
      var thin = n === 'message' && el.value.trim().length > 0 && el.value.trim().length < 10;
      var off = empty || badEmail || badPhone || thin;
      setInvalid(el, off);
      if (off && !bad) { el.focus(); bad = true; }
    });
    if (bad) return;

    var tier = form.elements.budget.value;
    var tierLabel = form.elements.budget.selectedOptions[0].textContent.trim();
    var value = leadValue(kind, tier);

    var payload = {
      form: kind,
      name: form.elements.name.value.trim(),
      email: form.elements.email.value.trim(),
      phone: form.elements.phone.value.trim(),
      business: form.elements.business.value.trim(),
      website: form.elements.website ? form.elements.website.value.trim() : '',
      budget_tier: tier,
      budget_label: tierLabel,
      message: form.elements.message ? form.elements.message.value.trim() : '',
      lead_value: value,
      qualified: value > 0,
      event_id: uid(),
      source: 'in.zyvextech.co',
      page: window.location.pathname,
      submitted_at: new Date().toISOString()
    };

    btn.disabled = true;
    btn.textContent = 'Sending';

    deliver(payload).then(function (sent) {
      trackLead(payload);
      if (sent) {
        form.style.display = 'none';
        if (note) note.style.display = 'none';
        if (done) done.style.display = 'block';
        if (done) done.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } else {
        btn.disabled = false;
        btn.textContent = 'Send it';
      }
    }).catch(function () {
      btn.disabled = false;
      btn.textContent = 'Send it';
      if (note) {
        note.textContent = 'That did not go through. Email ' + CONFIG.FALLBACK_EMAIL
          + ' and we will pick it up from there.';
        note.style.color = '#d98b8b';
      }
    });
  });

  /* clear the error state as soon as the person starts fixing it */
  Array.prototype.forEach.call(form.querySelectorAll('input,select,textarea'), function (el) {
    el.addEventListener('input', function () { setInvalid(el, false); });
  });
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

  initForm();
  initFounderVideo();
  initReveal();
});
