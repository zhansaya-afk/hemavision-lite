// Service worker: при установке кладёт все файлы приложения в кэш, дальше отвечает из кэша.
// После первой загрузки приложение работает в режиме полёта. Никаких запросов на сторонние адреса.

const VERSION = 'hv-lite-1.1.2';
const FILES = [
  './', 'index.html', 'app.js', 'manifest.webmanifest',
  'src/color.js', 'src/features.js', 'src/quality.js', 'src/risk.js', 'src/personalizer.js',
  'src/assistant.js', 'src/camera.js', 'src/roi.js', 'src/report.js', 'src/store.js', 'src/i18n.js',
  'i18n/ru.json', 'i18n/kk.json', 'kb/ru.json', 'kb/kk.json', 'model/model.json',
  'styles/app.css', 'styles/print.css',
  'assets/icons/icon-192.png', 'assets/icons/icon-512.png', 'assets/icons/maskable-512.png',
  'assets/howto/light.svg', 'assets/howto/lid.svg', 'assets/howto/oval.svg',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((hit) => {
      if (hit) return hit;
      if (e.request.mode === 'navigate') return caches.match('index.html');
      return fetch(e.request);
    }),
  );
});
