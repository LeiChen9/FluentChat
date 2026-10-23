// Web Push 服务 worker：push 事件出系统通知，点击聚焦回应用。
// 通知体全来自服务端签发+加密的 push payload（VAPID + aes128gcm）。
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch {}
  e.waitUntil(self.registration.showNotification(d.title || "FluentChat", {
    body: d.body || "New message for you.",
    tag: d.unit || "fluentchat", // 同一会话连着来只刷横幅，不堆角标
    renotify: true,
    data: { unit: d.unit || "" },
  }));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const unit = (e.notification.data && e.notification.data.unit) || "";
  e.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of list) {
      await c.focus?.();
      if (unit) c.postMessage({ kind: "open-chat", unit });
      return;
    }
    await self.clients.openWindow("/");
  })());
});
