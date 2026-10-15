/* Trang vá trên web: chọn ISO gốc → kiểm tra → vá → ghi ISO mới ra đĩa. Mọi thứ chạy trên máy người chơi.
 * Ghi ra đĩa theo thứ tự ưu tiên: showSaveFilePicker (Chrome, Edge), service worker tải xuống theo
 * luồng (Firefox…), cuối cùng là gom cả file trong bộ nhớ (cần nhiều RAM).
 * Thông số bản vá: window.PATCH (tools/site_build.py điền vào trang).
 */
"use strict";
(function () {
  var P = window.PATCH;
  var $ = function (id) { return document.getElementById(id); };
  var worker = null, file = null, busy = false;

  function fmt(n) { return n.toLocaleString("vi-VN"); }
  function hex(n) { return (n >>> 0).toString(16).padStart(8, "0"); }
  function show(id, on) { $(id).hidden = !on; }
  function say(html, kind) {
    var el = $("msg");
    el.className = "note " + (kind || "");
    el.innerHTML = html;
    el.hidden = false;
  }
  function bar(done, total, label) {
    show("prog", true);
    var pct = total ? (100 * done / total) : 0;
    $("prog-bar").style.width = pct.toFixed(1) + "%";
    $("prog-txt").textContent = label + " " + pct.toFixed(0) + "%";
  }

  function newWorker() {
    if (worker) worker.terminate();
    worker = new Worker("worker.js");
    return worker;
  }

  /* ---- chọn file và kiểm tra ---- */
  var FORMAT_HINT = {
    gcz: "Đây là file GCZ.", wia: "Đây là file WIA.", ciso: "Đây là file CISO.",
    nkit: "Đây là file NKit: Dolphin không đưa NKit về đúng bản gốc được, hãy khôi phục bằng công cụ NKit (Recover) hoặc trích lại từ đĩa.",
    khac: "Không nhận ra file này là ảnh đĩa GameCube."
  };
  var GAME_HINT = { GFEE01: "bản Mỹ", GFEJ01: "bản Nhật" };

  function pick(f) {
    if (busy || !f) return;
    file = f;
    show("go", false);
    $("file-name").textContent = f.name + " (" + fmt(f.size) + " byte)";
    busy = true;
    say("Đang kiểm tra file…");
    var w = newWorker();
    w.onmessage = function (e) {
      var m = e.data;
      if (m.type === "progress") bar(m.done, m.total, "Kiểm tra ISO gốc");
      else if (m.type === "checked") {
        busy = false;
        show("prog", false);
        if (m.ok && m.kind === "rvz") {
          say("<strong>File RVZ đúng game</strong> (" + m.gameId + ", bản châu Âu). Dữ liệu sẽ được kiểm tra trong lúc patch. Bấm nút bên dưới để patch.", "good");
          show("go", true);
        } else if (m.ok) {
          say("<strong>ISO gốc đúng bản.</strong> CRC32 " + hex(m.crc32) + " khớp bản chuẩn Redump. Bấm nút bên dưới để patch.", "good");
          show("go", true);
        } else if (m.reason === "format") {
          say("<strong>Định dạng chưa hỗ trợ.</strong> " + FORMAT_HINT[m.kind] +
              " Trang nhận ISO hoặc RVZ; hãy đổi bằng Dolphin (chuột phải vào game → Convert File… → ISO hoặc RVZ).", "bad");
        } else if (m.reason === "game") {
          say("<strong>Không đúng game hoặc không đúng bản.</strong> File này là " + m.gameId +
              (GAME_HINT[m.gameId] ? " (" + GAME_HINT[m.gameId] + ")" : "") + "; patch này cần " + P.gameId + " (bản châu Âu).", "bad");
        } else if (m.reason === "size") {
          say("<strong>Ảnh đĩa không đủ kích thước gốc</strong> (cần " + fmt(P.srcSize) + " byte). Có thể đã bị cắt gọn (NKit, scrub); hãy dùng bản trích đầy đủ.", "bad");
        } else {
          say("<strong>ISO không đúng bản gốc</strong> (CRC32 " + hex(m.crc32) + ", cần " + hex(P.srcCrc32) + "). " +
              "Có thể ISO đã bị sửa hoặc trích lỗi. Xem phần hướng dẫn ở trang chính.", "bad");
        }
      } else if (m.type === "error") { busy = false; show("prog", false); say("<strong>Lỗi:</strong> " + m.message, "bad"); }
    };
    w.postMessage({ cmd: "check", file: f, expect: P });
  }

  /* ---- nơi ghi ISO mới ---- */
  async function sinkFile() {
    var handle = await window.showSaveFilePicker({
      suggestedName: P.outName,
      types: [{ description: "Ảnh đĩa ISO", accept: { "application/octet-stream": [".iso"] } }]
    });
    var w = await handle.createWritable();
    return { kind: "file", write: function (c) { return w.write(c); }, close: function () { return w.close(); },
             abort: function () { return w.abort(); } };
  }

  async function sinkServiceWorker() {
    var reg = await navigator.serviceWorker.register("sw.js");
    await navigator.serviceWorker.ready;
    var sw = reg.active || reg.waiting || reg.installing;
    var ch = new MessageChannel(), id = Math.random().toString(36).slice(2), waiting = null;
    ch.port1.onmessage = function (e) {
      if (e.data === "cancel") { if (waiting) waiting.reject(new Error("tải xuống đã bị hủy")); return; }
      if (waiting) { var w = waiting; waiting = null; w.resolve(); }
    };
    var ready = new Promise(function (resolve, reject) { waiting = { resolve: resolve, reject: reject }; });
    sw.postMessage({ type: "stream", id: id, filename: P.outName, size: P.outSize }, [ch.port2]);
    await ready;
    var frame = document.createElement("iframe");
    frame.hidden = true;
    frame.src = "dl/" + id + "/" + encodeURIComponent(P.outName);
    document.body.appendChild(frame);
    return {
      kind: "stream",
      write: function (c) {
        return new Promise(function (resolve, reject) {
          waiting = { resolve: resolve, reject: reject };
          ch.port1.postMessage(c.buffer, [c.buffer]);
        });
      },
      close: function () { ch.port1.postMessage("end"); },
      abort: function () { ch.port1.postMessage("abort"); }
    };
  }

  function sinkMemory() {
    var parts = [];
    return {
      kind: "memory",
      write: function (c) { parts.push(c); return Promise.resolve(); },
      close: function () {
        var a = document.createElement("a");
        a.href = URL.createObjectURL(new Blob(parts, { type: "application/octet-stream" }));
        a.download = P.outName;
        document.body.appendChild(a);
        a.click();
        parts = [];
      },
      abort: function () { parts = []; }
    };
  }

  async function openSink() {
    if (window.showSaveFilePicker) return sinkFile();      // gọi ngay trong lượt bấm nút (cần cử chỉ người dùng)
    if ("serviceWorker" in navigator && window.isSecureContext) {
      try { return await sinkServiceWorker(); } catch (e) { /* thử cách cuối */ }
    }
    return sinkMemory();
  }

  /* ---- vá ---- */
  async function run() {
    if (busy || !file) return;
    var sink;
    try {
      sink = await openSink();
    } catch (e) {
      if (e && e.name === "AbortError") return;           // người dùng đóng hộp chọn nơi lưu
      say("<strong>Không mở được nơi lưu:</strong> " + e.message, "bad");
      return;
    }
    busy = true;
    show("go", false);
    say(sink.kind === "file" ? "Đang patch và ghi ra file đã chọn…"
        : sink.kind === "stream" ? "Đang patch, trình duyệt đang tải file xuống (xem thanh tải xuống)…"
        : "Đang patch trong bộ nhớ (trình duyệt này không ghi thẳng ra đĩa được, cần khoảng 1,5 GB RAM trống)…");
    var w = newWorker(), failed = false;
    w.onmessage = async function (e) {
      var m = e.data;
      if (m.type === "progress") bar(m.done, m.total, "Patch");
      else if (m.type === "chunk") {
        try { await sink.write(m.data); w.postMessage({ cmd: "ack" }); }
        catch (err) { failed = true; w.terminate(); busy = false; sink.abort(); say("<strong>Lỗi khi ghi:</strong> " + err.message, "bad"); }
      } else if (m.type === "done") {
        busy = false;
        if (m.size !== P.outSize || m.crc32 !== P.outCrc32) {
          sink.abort();
          say("<strong>ISO patch ra không khớp</strong> (CRC32 " + hex(m.crc32) + ", cần " + hex(P.outCrc32) + "). Đừng dùng file này; hãy báo lỗi.", "bad");
          return;
        }
        await sink.close();
        show("prog", false);
        say("<strong>Xong!</strong> Đã tạo <code>" + P.outName + "</code> (CRC32 " + hex(m.crc32) + ", đúng bản Việt hóa " +
            P.version + "). Nhớ đặt ngôn ngữ máy trong Dolphin là <strong>English</strong> trước khi chơi.", "good");
      } else if (m.type === "error" && !failed) {
        busy = false;
        sink.abort();
        say("<strong>Lỗi khi patch:</strong> " + m.message +
            (/adler32/.test(m.message) ? ". File gốc có dữ liệu khác bản chuẩn (trích lỗi hoặc đã bị sửa)." : ""), "bad");
      }
    };
    w.postMessage({ cmd: "patch", file: file, patchUrl: P.file, expect: P });
  }

  /* ---- gắn sự kiện ---- */
  if (!P || !P.file) {
    say("Chưa có patch cho phiên bản này. Hãy quay lại sau.", "bad");
    $("pick").disabled = true;
    return;
  }
  if (!window.Worker || !window.Blob || !Blob.prototype.slice) {
    say("Trình duyệt này quá cũ để patch trên web. Hãy dùng công cụ patch trong phần hướng dẫn.", "bad");
    return;
  }
  $("pick").addEventListener("change", function () { pick(this.files[0]); });
  $("go").addEventListener("click", run);
  var drop = $("drop");
  ["dragenter", "dragover"].forEach(function (t) {
    drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.add("over"); });
  });
  ["dragleave", "drop"].forEach(function (t) {
    drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.remove("over"); });
  });
  drop.addEventListener("drop", function (e) { if (e.dataTransfer.files[0]) pick(e.dataTransfer.files[0]); });
  if (!window.showSaveFilePicker) show("mode-note", true);
})();
