/* Service worker cho trình duyệt không có showSaveFilePicker (Firefox…): biến luồng dữ liệu từ trang
 * thành một lượt tải xuống, ghi thẳng ra đĩa thay vì giữ cả ISO 1,46 GB trong RAM.
 * Trang gửi {type: "stream", id, filename, size} kèm một MessagePort, rồi mở ./dl/<id>/<filename>;
 * mỗi khúc gửi qua port, service worker đáp "ack" khi luồng còn chỗ (để trang không gửi quá nhanh).
 */
"use strict";
var streams = new Map();

self.addEventListener("install", function () { self.skipWaiting(); });
self.addEventListener("activate", function (e) { e.waitUntil(self.clients.claim()); });

self.addEventListener("message", function (e) {
  var m = e.data;
  if (!m || m.type !== "stream") return;
  var port = e.ports[0], pending = false, ctl;
  var stream = new ReadableStream({
    start: function (c) { ctl = c; },
    pull: function () {
      if (pending) { pending = false; port.postMessage("ack"); }
    },
    cancel: function () { port.postMessage("cancel"); }
  }, { highWaterMark: 4, size: function () { return 1; } });
  port.onmessage = function (ev) {
    var d = ev.data;
    if (d === "end") { ctl.close(); streams.delete(m.id); return; }
    if (d === "abort") { ctl.error(new Error("đã hủy")); streams.delete(m.id); return; }
    ctl.enqueue(new Uint8Array(d));
    if (ctl.desiredSize > 0) port.postMessage("ack");
    else pending = true;
  };
  streams.set(m.id, { stream: stream, filename: m.filename, size: m.size });
  port.postMessage("ready");
});

self.addEventListener("fetch", function (e) {
  var url = new URL(e.request.url);
  var match = url.pathname.match(/\/dl\/([^/]+)\//);
  if (!match || !streams.has(match[1])) return;
  var s = streams.get(match[1]);
  e.respondWith(new Response(s.stream, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(s.size),
      "Content-Disposition": "attachment; filename=\"" + s.filename + "\""
    }
  }));
});
