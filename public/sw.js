// public/sw.js — service worker for Know Your Game
// Handles web-push notifications (daily rundown alerts) and click-through.

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// A push arrived from the server (api/notify.js)
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = {};
  }

  const title = data.title || "Know Your Game";
  const options = {
    body: data.body || "Today's games are ready — tap to see what's worth watching.",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    data: { url: data.url || "/" },
    // Same tag = replace, not stack (e.g. a re-sent playoff alert for the same day).
    ...(data.tag ? { tag: data.tag } : {}),
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// User tapped the notification — focus the app (or open it), which shows
// the daily rundown pop-up on load.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";

  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clientList) => {
        for (const client of clientList) {
          if ("focus" in client) return client.focus();
        }
        if (self.clients.openWindow) return self.clients.openWindow(url);
      })
  );
});
