// Regression tests for api/submit-lead.js budget mapping and conversion values.
// Run: node --test tests/submit-lead.test.js
// The real handler runs with fetch mocked, so nothing reaches Zoho or Meta.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

Object.assign(process.env, {
  META_PIXEL_ID: 'test-pixel',
  META_CAPI_TOKEN: 'test-token',
  ZOHO_REFRESH_TOKEN: 'test-refresh',
  ZOHO_CLIENT_ID: 'test-client',
  ZOHO_CLIENT_SECRET: 'test-secret',
});

const handler = require(path.join(__dirname, '..', 'api', 'submit-lead.js'));

let requests = [];
let warnings = [];
global.fetch = async function (url, opts) {
  if (url.includes('accounts.zoho.in')) {
    return { ok: true, json: async () => ({ access_token: 'test-access' }) };
  }
  requests.push({ url, body: JSON.parse(opts.body) });
  return { ok: true, json: async () => ({ data: [{ status: 'success' }] }), text: async () => '' };
};
let infos = [];
console.info = function () { infos.push(Array.from(arguments).join(' ')); };
console.warn = function () { warnings.push(Array.from(arguments).join(' ')); };

async function submit(form, fields) {
  requests = [];
  warnings = [];
  let status;
  const res = {
    setHeader() {},
    status(code) { status = code; return this; },
    json() { return this; },
  };
  const body = Object.assign({
    form,
    name: 'Test Person',
    email: 'test@example.com',
    phone: '+91 9999999999',
    business: 'Test Co',
    event_id: 'evt-123',
  }, fields);
  await handler({ method: 'POST', headers: {}, body }, res);
  const zoho = requests.find((r) => r.url.includes('zohoapis.in'));
  const meta = requests.find((r) => r.url.includes('graph.facebook.com'));
  return {
    status,
    zoho: zoho && zoho.body.data[0],
    meta: meta && meta.body.data[0],
    warnings,
  };
}

const CURRENT_OPTIONS = [
  // [form, budget_tier, Zoho Budget, CAPI value, event name]
  ['retainer', '25k-50k',  '25K - 50K',  25000, 'FullStackLead'],
  ['retainer', '50k-1l',   '50K - 1L',   50000, 'FullStackLead'],
  ['retainer', '1l-5l',    '1L - 5L',   100000, 'FullStackLead'],
  ['retainer', '5l-20l',   '5L - 20L',  300000, 'FullStackLead'],
  ['retainer', '20l-plus', '20L +',     300000, 'FullStackLead'],
  ['shopify',  '25k-50k',  '25K - 50K',  25000, 'ShopifyLead'],
  ['shopify',  '50k-1l',   '50K - 1L',   50000, 'ShopifyLead'],
  ['shopify',  '1l-3l',    '1L - 3L',   100000, 'ShopifyLead'],
  ['shopify',  '3l-5l',    '3L - 5L',   300000, 'ShopifyLead'],
];

for (const [form, tier, zohoBudget, value, eventName] of CURRENT_OPTIONS) {
  test(`${form} ${tier} sends Budget "${zohoBudget}" and CAPI value ${value}`, async () => {
    const r = await submit(form, { budget_tier: tier, budget_label: 'Label text' });
    assert.equal(r.status, 200);
    assert.equal(r.zoho.Budget, zohoBudget);
    assert.equal(r.meta.custom_data.value, value);
    assert.equal(r.meta.custom_data.currency, 'INR');
    assert.equal(r.meta.event_name, eventName);
    assert.equal(r.meta.event_id, 'evt-123');
    assert.deepEqual(r.warnings, []);
  });
}

function assertNoBudget(r) {
  assert.equal(r.status, 200);
  assert.ok(r.zoho, 'Zoho lead is still sent');
  assert.equal(r.zoho.Last_Name, 'Person');
  assert.ok(!('Budget' in r.zoho), 'Budget is left empty');
  assert.ok(r.meta, 'CAPI event is still sent');
  assert.ok(!('value' in r.meta.custom_data), 'no CAPI value');
}

test('unknown tier leaves Budget empty, never sends the raw label, and warns', async () => {
  const r = await submit('retainer', { budget_tier: '1l-2l', budget_label: '₹1,00,000 to ₹2,00,000' });
  assertNoBudget(r);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /Unmapped budget/);
  assert.ok(!r.warnings[0].includes('₹'), 'label is not logged');
});

test('arbitrary budget text is not sent', async () => {
  assertNoBudget(await submit('retainer', { budget: 'anything at all' }));
});

test('over-long budget text is not sent and the warning is short', async () => {
  const r = await submit('retainer', { budget: 'x'.repeat(300) });
  assertNoBudget(r);
  assert.ok(r.warnings[0].length < 100);
});

test('control characters are stripped from the warning', async () => {
  const r = await submit('retainer', { budget_tier: 'bad\ntier\u0000' });
  assertNoBudget(r);
  assert.ok(!/[\u0000-\u001f]/.test(r.warnings[0]));
});

for (const key of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
  test(`prototype key "${key}" is not sent to Zoho or CAPI`, async () => {
    assertNoBudget(await submit('retainer', { budget_tier: key }));
  });
}

test('object budget values are not sent', async () => {
  assertNoBudget(await submit('retainer', { budget: { a: 1 } }));
  assertNoBudget(await submit('shopify', { budget_tier: { toString: () => '50k-1l' } }));
});

test('array and number budget values are not sent', async () => {
  assertNoBudget(await submit('retainer', { budget_tier: ['50k-1l'] }));
  assertNoBudget(await submit('retainer', { budget: 50000 }));
});

test('no budget at all leaves Budget empty without a warning', async () => {
  const r = await submit('retainer', {});
  assertNoBudget(r);
  assert.deepEqual(r.warnings, []);
});

test('legacy budget "50k-1l" without budget_tier still maps', async () => {
  const r = await submit('retainer', { budget: '50k-1l' });
  assert.equal(r.zoho.Budget, '50K - 1L');
  assert.deepEqual(r.warnings, []);
});

test('Lead_Type, Lead_Source and Lead_Status are unchanged', async () => {
  const a = await submit('retainer', { budget_tier: '1l-5l' });
  assert.equal(a.zoho.Lead_Type, 'Full Stack Marketing');
  assert.equal(a.zoho.Lead_Source, 'Direct');
  assert.equal(a.zoho.Lead_Status, 'Not Contacted');
  const b = await submit('shopify', { budget_tier: '1l-3l' });
  assert.equal(b.zoho.Lead_Type, 'Shopify Builds');
});

test('each submission logs its event_id and event name, without personal data', async () => {
  for (const [form, eventName] of [['retainer', 'FullStackLead'], ['shopify', 'ShopifyLead']]) {
    infos = [];
    const r = await submit(form, { event_id: 'zx-mabc123-k9x2p1q' });
    assert.equal(r.meta.event_id, 'zx-mabc123-k9x2p1q');
    const line = infos.find((l) => l.startsWith('[submit-lead] Submitted:'));
    assert.ok(line);
    assert.deepEqual(JSON.parse(line.slice('[submit-lead] Submitted: '.length)),
      { event: eventName, event_id: 'zx-mabc123-k9x2p1q' });
    const all = infos.join('\n');
    for (const pii of ['Test Person', 'test@example.com', '9999999999', 'Test Co', 'test-token']) {
      assert.ok(!all.includes(pii), pii);
    }
  }
});

test('a malformed event_id is logged as null, never echoed', async () => {
  infos = [];
  await submit('retainer', { event_id: 'someone@example.com' });
  const line = infos.find((l) => l.startsWith('[submit-lead] Submitted:'));
  assert.ok(line.includes('"event_id":null'));
  assert.ok(!infos.join('\n').includes('someone@example.com'));
});
