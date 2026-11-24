/* Piano Companion service worker (v6): installable, works offline.
 * App files: network first (updates arrive immediately), cache when offline.
 * Libraries, sheet-music engine and piano samples: cache first. */
const VERSION = '6.3.0';
const SHELL = 'pc-shell-' + VERSION;
const RUNTIME = 'pc-runtime-v1';
const SHELL_FILES = [
  './', 'index.html', 'app.js', 'styles.css', 'hero.jpg', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png', 'icons/apple-touch-icon.png',
  'omr/engine.js', 'omr/geometry.js', 'omr/model.js', 'omr/homr.js', 'omr/worker.js', 'omr/workflow.js',
  'music/xml.js', 'music/musicxml.js', 'music/notation.js', 'music/practice.js', 'music/listen.js'
];
const CDN_HOSTS = /(^|\.)(cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|unpkg\.com|tonejs\.github\.io|verovio\.org|tessdata\.projectnaptha\.com)$/;

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith('pc-shell-') && k !== SHELL).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) e.respondWith(networkFirst(req));
  else if (CDN_HOSTS.test(url.hostname)) e.respondWith(cacheFirst(req));
});
function withTimeout(p, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    p.then(v => { clearTimeout(t); resolve(v); }, err => { clearTimeout(t); reject(err); });
  });
}
async function networkFirst(req) {
  try {
    const res = await withTimeout(fetch(req), 6000);
    if (res && res.ok && res.type === 'basic') (await caches.open(SHELL)).put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await caches.match(req, { ignoreSearch: true }) || (req.mode === 'navigate' ? await caches.match('index.html') : null);
    if (hit) return hit;
    throw err;
  }
}
async function cacheFirst(req) {
  const hit = await caches.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res && (res.ok || res.type === 'opaque')) (await caches.open(RUNTIME)).put(req, res.clone());
  return res;
}
