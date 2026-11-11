// Fallback for browsers without Declarative Web Push (iOS < 18.4, Chrome, Firefox).
self.addEventListener("push", (e) => {
  const { notification: n } = e.data.json();
  e.waitUntil(self.registration.showNotification(n.title, { body: n.body, data: { url: n.navigate } }));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(clients.openWindow(e.notification.data?.url ?? "/"));
});
