/* Web Worker của trình vá: nhận dạng file người chơi chọn (ISO hoặc RVZ), kiểm tra, rồi giải mã bản vá và
 * gửi từng khúc ISO mới về trang để ghi. Không gì rời khỏi máy người chơi. Giao tiếp:
 *   trang → worker: {cmd: "check", file, expect}  |  {cmd: "patch", file, patchUrl, expect}  |  {cmd: "ack"}
 *   worker → trang: {type: "progress", phase, done, total}
 *                   {type: "checked", ok, kind, reason, crc32, gameId}
 *                   {type: "chunk", data} (chờ "ack" mới gửi tiếp) | {type: "done", size, crc32} | {type: "error", message}
 * kind: "iso" | "rvz" | "gcz" | "wia" | "ciso" | "nkit" | "khac". reason (khi ok = false): "size" | "crc" | "game" | "format".
 */
"use strict";
importScripts("vcdiff.js", "fzstd.js", "rvz.js");

var file = null, ackResolve = null;
var CHUNK = 16 * 1024 * 1024;

function post(msg, transfer) { self.postMessage(msg, transfer || []); }

async function readSlice(pos, len) {
  return new Uint8Array(await file.slice(pos, pos + len).arrayBuffer());
}

function text(b, from, n) {
  var s = "";
  for (var i = from; i < from + n; i++) s += String.fromCharCode(b[i]);
  return s;
}

/* Loại file theo nội dung (không theo đuôi). */
async function detect() {
  var h = await readSlice(0, 0x210);
  var m = text(h, 0, 4);
  if (m === "RVZ\x01") return "rvz";
  if (m === "WIA\x01") return "wia";
  if (m === "CISO") return "ciso";
  if (h[0] === 0x01 && h[1] === 0xC0 && h[2] === 0x0B && h[3] === 0xB1) return "gcz";
  if (text(h, 0x200, 4) === "NKIT") return "nkit";
  if (h[0x1C] === 0xC2 && h[0x1D] === 0x33 && h[0x1E] === 0x9F && h[0x1F] === 0x3D) return "iso";   // magic đĩa GameCube
  return "khac";
}

async function source(expect) {
  var kind = await detect();
  if (kind === "rvz") {
    var r = new RvzReader(readSlice);
    var info = await r.open();
    return { kind: kind, gameId: info.gameId, size: info.isoSize, read: function (p, n) { return r.read(p, n); } };
  }
  if (kind === "iso") return { kind: kind, gameId: text(await readSlice(0, 6), 0, 6), size: file.size, read: readSlice };
  return { kind: kind };
}

async function check(expect) {
  var s = await source(expect);
  if (!s.read) { post({ type: "checked", ok: false, kind: s.kind, reason: "format" }); return; }
  if (s.gameId !== expect.gameId) { post({ type: "checked", ok: false, kind: s.kind, reason: "game", gameId: s.gameId }); return; }
  if (s.size !== expect.srcSize) { post({ type: "checked", ok: false, kind: s.kind, reason: "size", gameId: s.gameId }); return; }
  if (s.kind === "rvz") {
    // RVZ: kiểm tra toàn bộ sẽ mất gấp đôi thời gian; dữ liệu được kiểm từng cửa sổ (adler32) khi vá,
    // và ISO ra được so CRC32 lúc cuối
    post({ type: "checked", ok: true, kind: "rvz", gameId: s.gameId });
    return;
  }
  var crc = 0;
  for (var pos = 0; pos < file.size; pos += CHUNK) {
    crc = crc32(await readSlice(pos, Math.min(CHUNK, file.size - pos)), crc);
    post({ type: "progress", phase: "check", done: Math.min(pos + CHUNK, file.size), total: file.size });
  }
  post({ type: "checked", ok: crc === expect.srcCrc32, kind: "iso", reason: "crc", crc32: crc, gameId: s.gameId });
}

async function patch(patchUrl, expect) {
  var s = await source(expect);
  if (!s.read) throw new Error("định dạng file không hỗ trợ");
  var res = await fetch(patchUrl);
  if (!res.ok) throw new Error("không tải được bản vá (" + res.status + ")");
  var bytes = new Uint8Array(await res.arrayBuffer());
  var result = await vcdiffDecode(bytes, s.read, function (chunk) {
    return new Promise(function (resolve) {
      ackResolve = resolve;
      post({ type: "chunk", data: chunk }, [chunk.buffer]);
    });
  }, function (done) {
    post({ type: "progress", phase: "patch", done: done, total: expect.outSize });
  });
  post({ type: "done", size: result.size, crc32: result.crc32 });
}

self.onmessage = function (e) {
  var m = e.data;
  if (m.cmd === "ack") {
    var r = ackResolve;
    ackResolve = null;
    if (r) r();
    return;
  }
  file = m.file;
  var job = m.cmd === "check" ? check(m.expect) : patch(m.patchUrl, m.expect);
  job.catch(function (err) { post({ type: "error", message: err && err.message ? err.message : String(err) }); });
};
