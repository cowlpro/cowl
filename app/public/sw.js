// Service worker COWL: hanya supaya aplikasi bisa dipasang di layar HP.
// Sengaja TIDAK menyimpan cache: halaman & config selalu diambil segar (CA, nama, dan kode bisa berubah).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
