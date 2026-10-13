import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const script = readFileSync(new URL('../crates/kdj-providers/src/browser/arc_soundcloud.js', import.meta.url), 'utf8');
const read = (cookie, origin = 'https://soundcloud.com', readyState = 'complete') => JSON.parse(runInNewContext(script, {
  location: { origin }, document: { cookie, readyState },
}));

test('Arc returns only the SoundCloud login value and checks the page before reading cookies', () => {
  assert.deepEqual(read('unrelated=private; oauth_token=test%2Donly; another=value'), { status: 'ok', token: 'test-only' });
  for (const origin of ['https://soundcloud.com.evil.test', 'http://soundcloud.com', 'https://accounts.soundcloud.com']) {
    const result = runInNewContext(script, { location: { origin }, document: { get cookie() { throw Error('must not read'); } } });
    assert.deepEqual(JSON.parse(result), { status: 'wrong_site' });
  }
  assert.deepEqual(read('oauth_token=test-only', 'https://soundcloud.com', 'loading'), { status: 'loading' });
});

test('Arc rejects ambiguous, malformed and oversized login values', () => {
  assert.deepEqual(read('oauth_token=one; oauth_token=two'), { status: 'ambiguous' });
  assert.deepEqual(read('oauth_token=one; oauth_token=one'), { status: 'ok', token: 'one' });
  for (const cookie of ['', 'not_oauth_token=other', 'oauth_token=', 'oauth_token=%XX', 'oauth_token=%0D%0A', `oauth_token=${'x'.repeat(4097)}`]) {
    assert.deepEqual(read(cookie), { status: 'not_logged_in' });
  }
});

const youtubeTemplate = readFileSync(new URL('../crates/kdj-providers/src/browser/arc_youtube.js', import.meta.url), 'utf8');
test('Arc YouTube automation keeps the selected site and only its login cookie names', () => {
  for (const origin of ['https://music.youtube.com', 'https://www.youtube.com']) {
    const javascript = youtubeTemplate.replace('__SITE_ORIGIN__', JSON.stringify(origin))
      .replace('__COOKIE_NAMES__', JSON.stringify(['SAPISID', 'SID']));
    const run = (cookie, actualOrigin = origin) => JSON.parse(runInNewContext(javascript, {
      location: { origin: actualOrigin }, document: { cookie, readyState: 'complete' },
      navigator: { userAgent: 'Test' }, ytcfg: { get: () => '2' },
    }));
    assert.deepEqual(run('unrelated=secret; SAPISID=test-only; SID=also-test'), {
      status: 'ok', cookie: 'SAPISID=test-only; SID=also-test', metadata: { authUser: '2', userAgent: 'Test' },
    });
    assert.deepEqual(run('SAPISID=a; SAPISID=b'), { status: 'ambiguous' });
    assert.deepEqual(run('SID=test-only'), { status: 'not_logged_in' });
    const badSite = runInNewContext(javascript, {
      location: { origin: 'https://accounts.google.com' }, document: { get cookie() { throw Error('must not read another site'); } },
    });
    assert.deepEqual(JSON.parse(badSite), { status: 'wrong_site' });
  }
});
