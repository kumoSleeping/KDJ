import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const origin = 'https://www.youtube.com';
const script = readFileSync(new URL('../crates/kdj-providers/src/browser/gecko_login.js', import.meta.url), 'utf8')
  .replace('__SITE_ORIGIN__', JSON.stringify(origin)).replace('__COOKIE_NAMES__', JSON.stringify(['SAPISID']));
const page = (suffix = '', privateBrowsingId = 0, site = origin) => ({
  currentURI: { prePath: site }, browserId: 42,
  contentPrincipal: { originNoSuffix: site, originSuffix: suffix, originAttributes: { privateBrowsingId, userContextId: suffix ? 2 : 0 } },
});
const cookie = (overrides = {}) => ({ name: 'SAPISID', value: 'test-only', host: '.youtube.com', path: '/', isSession: true, ...overrides });
function evaluate(pages: ReturnType<typeof page>[], cookies = [cookie()], permission = true, selectedId: number | null = null) {
  let reads = 0;
  const result = runInNewContext(script.replace('__BROWSER_ID__', JSON.stringify(selectedId)), { URL, Services: {
    prefs: { getBoolPref: () => permission },
    wm: { getEnumerator: () => [{ gBrowser: { browsers: pages } }] },
    cookies: { getCookiesFromHost: (host: string, attributes: unknown) => {
      reads++;
      assert.equal(host, 'www.youtube.com');
      assert.deepEqual(attributes, pages[0].contentPrincipal.originAttributes);
      return cookies;
    } },
  } });
  return { result: JSON.parse(result), reads };
}
test('Gecko requires browser permission and a unique non-private site container before cookie access', () => {
  assert.deepEqual(evaluate([page()], undefined, false), { result: { status: 'permission_required' }, reads: 0 });
  assert.deepEqual(evaluate([page('', 1)]), { result: { status: 'no_page' }, reads: 0 });
  assert.deepEqual(evaluate([page('', 0, 'https://www.youtube.com.evil.test')]), { result: { status: 'no_page' }, reads: 0 });
  assert.deepEqual(evaluate([page(), page('^userContextId=2')]), { result: { status: 'ambiguous' }, reads: 0 });
});
test('Gecko returns only live root-path login cookies for the selected site and container', () => {
  const { result, reads } = evaluate([page('^userContextId=2')], [cookie(), cookie({ host: '.google.com' }),
    cookie({ name: 'unrelated' }), cookie({ path: '/private' }), cookie({ isSession: false, expiry: 1 }),
    cookie({ host: '.evil-youtube.com' }), cookie({ host: 'music.youtube.com' })]);
  assert.equal(reads, 1);
  assert.equal(result.status, 'ok');
  assert.equal(result.browserId, 42);
  assert.deepEqual(result.cookies, [{ name: 'SAPISID', value: 'test-only', domain: '.youtube.com', path: '/', expires: -1 }]);
});

test('Gecko pins the selected page across redirects and never changes to another account', () => {
  const selected = page('', 0, 'https://accounts.google.com');
  const other = { ...page(), browserId: 99 };
  assert.deepEqual(evaluate([selected, other], undefined, true, 42), { result: { status: 'waiting' }, reads: 0 });
  assert.deepEqual(evaluate([other], undefined, true, 42), { result: { status: 'closed' }, reads: 0 });
  const returned = evaluate([page(), other], undefined, true, 42);
  assert.equal(returned.result.browserId, 42);
  assert.equal(returned.reads, 1);
});
