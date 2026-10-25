// Service worker for push notifications only: it shows the message and opens its link on tap. No caching, no tracking.
self.addEventListener("push", (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch { /* not JSON: show the generic title */ }
  event.waitUntil(self.registration.showNotification(d.title || "Marichi", { body: d.body || "", data: { url: d.url || "/notifications" } }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  // Only open pages on our own site, whatever the message said.
  let url = new URL("/notifications", self.location.origin);
  try {
    const u = new URL(event.notification.data && event.notification.data.url, self.location.origin);
    if (u.origin === self.location.origin) url = u;
  } catch { /* keep the default */ }
  event.waitUntil(self.clients.openWindow(url.href));
});
