/* Giải mã bản vá VCDIFF (RFC 3284) do xdelta3 tạo, kiểu đọc–ghi từng cửa sổ: bộ nhớ chỉ cần cỡ một
 * cửa sổ (vài MB), không phải nạp cả ISO 1,46 GB. Hỗ trợ đúng những gì `fe9.py patch` tạo ra:
 * cửa sổ VCD_SOURCE, không nén thứ cấp (-S none), bảng mã mặc định, checksum adler32 của xdelta.
 * Dùng chung cho Web Worker (patcher-worker.js) và bản thử bằng jsc (tools/test_web_patcher.js).
 */
"use strict";

var CRC_TABLE = (function () {
  var t = new Int32Array(256);
  for (var n = 0; n < 256; n++) {
    var c = n;
    for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

/* crc32(dữ liệu, crc trước đó) -> crc mới (số không dấu). Gọi nối tiếp cho từng khúc. */
function crc32(buf, crc) {
  var c = (crc === undefined ? 0 : crc) ^ -1;
  for (var i = 0, n = buf.length; i < n; i++) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function adler32(buf) {
  var a = 1, b = 0, i = 0, n = buf.length;
  while (i < n) {
    var end = Math.min(i + 3800, n);
    for (; i < end; i++) { a += buf[i]; b += a; }
    a %= 65521; b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

var NOOP = 0, ADD = 1, RUN = 2, COPY = 3;
var S_NEAR = 4, S_SAME = 3;

/* Bảng mã mặc định RFC 3284 §5.6: mỗi mục [inst1, size1, mode1, inst2, size2, mode2]. */
var CODE_TABLE = (function () {
  var t = [[RUN, 0, 0, NOOP, 0, 0]];
  var s, m, a, c;
  for (s = 0; s <= 17; s++) t.push([ADD, s, 0, NOOP, 0, 0]);
  for (m = 0; m < 9; m++) {
    t.push([COPY, 0, m, NOOP, 0, 0]);
    for (s = 4; s <= 18; s++) t.push([COPY, s, m, NOOP, 0, 0]);
  }
  for (m = 0; m <= 5; m++)
    for (a = 1; a <= 4; a++)
      for (c = 4; c <= 6; c++) t.push([ADD, a, 0, COPY, c, m]);
  for (m = 6; m <= 8; m++)
    for (a = 1; a <= 4; a++) t.push([ADD, a, 0, COPY, 4, m]);
  for (m = 0; m <= 8; m++) t.push([COPY, 4, m, ADD, 1, 0]);
  if (t.length !== 256) throw new Error("bảng mã VCDIFF sai: " + t.length);
  return t;
})();

function Reader(buf, pos, end) {
  this.buf = buf; this.pos = pos; this.end = end;
}
Reader.prototype.byte = function () {
  if (this.pos >= this.end) throw new Error("bản vá bị cụt hoặc hỏng");
  return this.buf[this.pos++];
};
Reader.prototype.varint = function () {
  var v = 0, b;
  do {
    b = this.byte();
    v = v * 128 + (b & 127);
  } while (b & 128);
  return v;
};

/* Giải mã cả bản vá.
 *   patch: Uint8Array (cả file .xdelta, chỉ vài MB)
 *   readSource(pos, len) -> Promise<Uint8Array>   đọc đoạn ISO gốc
 *   writeTarget(Uint8Array) -> Promise             ghi tiếp ISO mới (dữ liệu đã thuộc về người gọi)
 *   onProgress(byte đã ghi)
 * Trả về {size, crc32} của dữ liệu đã ghi. */
async function vcdiffDecode(patch, readSource, writeTarget, onProgress) {
  if (patch[0] !== 0xD6 || patch[1] !== 0xC3 || patch[2] !== 0xC4 || patch[3] !== 0)
    throw new Error("không phải bản vá xdelta/VCDIFF");
  var r = new Reader(patch, 4, patch.length);
  var hdr = r.byte();
  if (hdr & 1) throw new Error("bản vá dùng nén thứ cấp, trình vá web không hỗ trợ");
  if (hdr & 2) throw new Error("bản vá dùng bảng mã riêng, trình vá web không hỗ trợ");
  if (hdr & 4) {                                      // app header của xdelta (tên file)
    var appLen = r.varint();                          // (không viết r.pos += r.varint(): JS đọc r.pos trước)
    r.pos += appLen;
  }
  var written = 0, crc = 0;
  while (r.pos < r.end) {
    var win = r.byte();
    if (win & 2) throw new Error("cửa sổ VCD_TARGET chưa hỗ trợ");
    var src = null, srcLen = 0;
    if (win & 1) {
      srcLen = r.varint();
      var srcPos = r.varint();
      src = await readSource(srcPos, srcLen);
      if (src.length !== srcLen) throw new Error("ISO gốc ngắn hơn bản vá cần");
    }
    r.varint();                                       // độ dài phần mã hóa
    var tgtLen = r.varint();
    if (r.byte() !== 0) throw new Error("phần dữ liệu bị nén, trình vá web không hỗ trợ");
    var dataLen = r.varint(), instLen = r.varint(), addrLen = r.varint();
    var sum = -1;
    if (win & 4) {
      sum = ((patch[r.pos] << 24) | (patch[r.pos + 1] << 16) | (patch[r.pos + 2] << 8) | patch[r.pos + 3]) >>> 0;
      r.pos += 4;
    }
    var data = new Reader(patch, r.pos, r.pos + dataLen);
    var inst = new Reader(patch, data.end, data.end + instLen);
    var addr = new Reader(patch, inst.end, inst.end + addrLen);
    r.pos = addr.end;

    var out = new Uint8Array(tgtLen), t = 0;
    var near = [0, 0, 0, 0], nextNear = 0, same = new Array(S_SAME * 256).fill(0);
    while (inst.pos < inst.end) {
      var e = CODE_TABLE[inst.byte()];
      for (var h = 0; h < 2; h++) {
        var op = e[h * 3], size = e[h * 3 + 1], mode = e[h * 3 + 2];
        if (op === NOOP) continue;
        if (size === 0) size = inst.varint();
        if (t + size > tgtLen) throw new Error("bản vá hỏng (ghi vượt cửa sổ)");
        if (op === ADD) {
          out.set(patch.subarray(data.pos, data.pos + size), t);
          data.pos += size;
          t += size;
        } else if (op === RUN) {
          out.fill(data.byte(), t, t + size);
          t += size;
        } else {
          var here = srcLen + t, a;
          if (mode === 0) a = addr.varint();
          else if (mode === 1) a = here - addr.varint();
          else if (mode < 2 + S_NEAR) a = near[mode - 2] + addr.varint();
          else a = same[(mode - 2 - S_NEAR) * 256 + addr.byte()];
          near[nextNear] = a;
          nextNear = (nextNear + 1) % S_NEAR;
          same[a % (S_SAME * 256)] = a;
          if (a + size <= srcLen) {
            out.set(src.subarray(a, a + size), t);
            t += size;
          } else {
            if (a < srcLen) {                         // nửa trong nguồn, nửa trong cửa sổ đích
              var k = srcLen - a;
              out.set(src.subarray(a, srcLen), t);
              t += k; size -= k; a = srcLen;
            }
            var from = a - srcLen;                    // chép trong chính cửa sổ đích, có thể chồng
            for (var j = 0; j < size; j++) out[t++] = out[from + j];
          }
        }
      }
    }
    if (t !== tgtLen) throw new Error("bản vá hỏng (cửa sổ thiếu dữ liệu)");
    if (sum >= 0 && adler32(out) !== sum)
      throw new Error("kiểm tra adler32 sai: ISO gốc không đúng bản (hoặc bản vá hỏng)");
    crc = crc32(out, crc);
    written += tgtLen;
    await writeTarget(out);
    if (onProgress) onProgress(written);
  }
  return { size: written, crc32: crc };
}

if (typeof module !== "undefined") module.exports = { vcdiffDecode: vcdiffDecode, crc32: crc32, adler32: adler32 };
