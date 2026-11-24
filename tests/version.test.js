// The version number lives in package.json; the service worker cache name and the
// changelog must match it, or installed apps won't pick up a new release.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const root = __dirname + '/..';

test('package.json, service worker and changelog agree on the version', () => {
  const pkg = JSON.parse(fs.readFileSync(root + '/package.json', 'utf8')).version;
  const sw = fs.readFileSync(root + '/sw.js', 'utf8').match(/const VERSION = '([^']+)'/)[1];
  const log = fs.readFileSync(root + '/CHANGELOG.md', 'utf8').match(/^## (\d+\.\d+\.\d+)/m)[1];
  assert.equal(sw, pkg, 'sw.js VERSION must equal package.json version (bump both)');
  assert.equal(log, pkg, 'CHANGELOG.md must start with an entry for ' + pkg);
});

test('every file the app loads is in the offline cache list', () => {
  const sw = fs.readFileSync(root + '/sw.js', 'utf8');
  const html = fs.readFileSync(root + '/index.html', 'utf8');
  const local = [...html.matchAll(/<script src="([^"]+)"/g)].map(m => m[1]).filter(s => !/^https?:/.test(s));
  for (const f of local) assert.ok(sw.includes("'" + f + "'"), f + ' is loaded by index.html but missing from the sw.js cache list');
});
