// Tests for the inline <head> script that points canonical/og:url at the live URL while
// a Meta click (fbclid) is present. Run: node --test tests/canonical.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
function htmlFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === '.git' || e.name === 'node_modules' ? [] : htmlFiles(p);
    return e.name.endsWith('.html') ? [p] : [];
  });
}
const FILES = htmlFiles(ROOT);

// Runs the page's canonical script against a minimal document built from its own head tags.
function run(file, url) {
  const html = fs.readFileSync(file, 'utf8');
  const canonical = { href: html.match(/<link rel="canonical" href="([^"]*)">/)[1] };
  const ogUrl = { content: html.match(/<meta property="og:url" content="([^"]*)">/)[1] };
  const script = html.match(/<script>(\/\* Instagram "Open in Chrome"[\s\S]*?)<\/script>/)[1];
  const u = new URL(url);
  const el = (o, attr) => ({ setAttribute(k, v) { if (k === attr) o[attr] = v; } });
  const document = {
    querySelector(sel) {
      if (sel === 'link[rel="canonical"]') return el(canonical, 'href');
      if (sel === 'meta[property="og:url"]') return el(ogUrl, 'content');
      return null;
    },
  };
  vm.runInNewContext(script, { location: { href: u.href, search: u.search }, document });
  return { canonical: canonical.href, ogUrl: ogUrl.content, staticUrl: html.match(/<link rel="canonical" href="([^"]*)">/)[1] };
}

test('all 18 pages carry the script once, right after og:url', () => {
  assert.equal(FILES.length, 18);
  for (const f of FILES) {
    const html = fs.readFileSync(f, 'utf8');
    assert.equal((html.match(/Instagram "Open in Chrome"/g) || []).length, 1, f);
    assert.match(html, /<meta property="og:url" content="[^"]*">\n<script>\/\* Instagram "Open in Chrome"/, f);
  }
});

test('with fbclid, canonical and og:url become the full live URL', () => {
  for (const f of FILES) {
    const clean = run(f, 'https://in.zyvextech.co/').staticUrl;
    const live = clean + '?utm_source=ig&fbclid=PAT01abc_def-123#start';
    const out = run(f, live);
    assert.equal(out.canonical, live, f);
    assert.equal(out.ogUrl, live, f);
  }
});

test('without fbclid, the static clean tags are untouched', () => {
  for (const f of FILES) {
    const clean = run(f, 'https://in.zyvextech.co/').staticUrl;
    for (const url of [clean, clean + '?utm_source=google&gclid=abc123xyz00', clean + '?notfbclid=x']) {
      const out = run(f, url);
      assert.equal(out.canonical, clean, f + ' ' + url);
      assert.equal(out.ogUrl, clean, f + ' ' + url);
    }
  }
});
