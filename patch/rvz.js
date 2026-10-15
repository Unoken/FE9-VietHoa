/* Đọc ảnh đĩa RVZ (định dạng nén của Dolphin) trong trình duyệt, cho ra đúng từng byte ISO gốc: dữ liệu
 * đệm (junk) sinh lại từ hạt giống lưu trong RVZ, như LaggedFibonacciGenerator của Dolphin. Chuyển từ
 * fe9lib/rvz.py (đã kiểm: ISO dựng ra khớp SHA-1 Redump). Chỉ đĩa GameCube, nén zstd hoặc không nén.
 * Cần fzstd.js (giải nén zstd). Dùng chung cho Web Worker và bản thử bằng jsc.
 */
"use strict";

var RVZ_K = 521, RVZ_J = 32, RVZ_BLOCK = 0x8000;

function RvzLfg(seed) {                   // seed: Uint8Array 68 byte (17 từ 32 bit big-endian)
  var b = new Uint32Array(RVZ_K), i;
  for (i = 0; i < 17; i++)
    b[i] = ((seed[i * 4] << 24) | (seed[i * 4 + 1] << 16) | (seed[i * 4 + 2] << 8) | seed[i * 4 + 3]) >>> 0;
  for (i = 17; i < RVZ_K; i++) b[i] = ((b[i - 17] << 23) ^ (b[i - 16] >>> 9) ^ b[i - 1]) >>> 0;
  for (i = 0; i < RVZ_K; i++) b[i] = ((b[i] & 0xFF00FFFF) | ((b[i] >>> 2) & 0x00FF0000)) >>> 0;
  this.b = b;
  this.bytes = new Uint8Array(RVZ_K * 4);
  for (i = 0; i < 4; i++) this.forward();
  this.pos = 0;
}
RvzLfg.prototype.forward = function () {
  var b = this.b, o = this.bytes, i;
  for (i = 0; i < RVZ_J; i++) b[i] ^= b[i + RVZ_K - RVZ_J];
  for (i = RVZ_J; i < RVZ_K; i++) b[i] ^= b[i - RVZ_J];
  for (i = 0; i < RVZ_K; i++) {
    var v = b[i];
    o[i * 4] = v >>> 24; o[i * 4 + 1] = v >>> 16; o[i * 4 + 2] = v >>> 8; o[i * 4 + 3] = v;
  }
};
RvzLfg.prototype.skip = function (n) {
  this.pos += n;
  while (this.pos >= RVZ_K * 4) { this.forward(); this.pos -= RVZ_K * 4; }
};
RvzLfg.prototype.take = function (out, at, n) {
  while (n > 0) {
    var k = Math.min(n, RVZ_K * 4 - this.pos);
    out.set(this.bytes.subarray(this.pos, this.pos + k), at);
    this.pos += k; at += k; n -= k;
    if (this.pos === RVZ_K * 4) { this.forward(); this.pos = 0; }
  }
};

function u32(a, p) { return ((a[p] << 24) | (a[p + 1] << 16) | (a[p + 2] << 8) | a[p + 3]) >>> 0; }
function u64(a, p) { return u32(a, p) * 4294967296 + u32(a, p + 4); }

/* read(pos, len) -> Promise<Uint8Array> cho Blob/File; jsc truyền vào một hàm đọc đồng bộ bọc Promise. */
function RvzReader(readAt) {
  this.readAt = readAt;
  this.cache = new Map();
}

/* Đọc header; trả về {gameId, isoSize}. Ném lỗi tiếng Việt nếu không phải RVZ GameCube đọc được. */
RvzReader.prototype.open = async function () {
  var head = await this.readAt(0, 0x48);
  if (head[0] !== 0x52 || head[1] !== 0x56 || head[2] !== 0x5A || head[3] !== 1)
    throw new Error("không phải file RVZ");
  var discSize = u32(head, 0x0C);
  this.isoSize = u64(head, 0x24);
  var d = await this.readAt(0x48, discSize);
  var discType = u32(d, 0), comp = u32(d, 4);
  this.chunk = u32(d, 12);
  if (discType !== 1) throw new Error("RVZ này không phải đĩa GameCube");
  if (comp !== 5 && comp !== 0)
    throw new Error("RVZ dùng kiểu nén chưa hỗ trợ (chỉ zstd, mặc định của Dolphin). Hãy đổi lại bằng Dolphin: Convert File → RVZ (zstd) hoặc ISO");
  this.zstd = comp === 5;
  this.dhead = d.subarray(0x10, 0x90);
  var nRaw = u32(d, 0xB4), rawOff = u64(d, 0xB8), rawSize = u32(d, 0xC0);
  var nGrp = u32(d, 0xC4), grpOff = u64(d, 0xC8), grpSize = u32(d, 0xD0);
  var raw = await this.table(rawOff, rawSize), grp = await this.table(grpOff, grpSize);
  this.raws = [];
  for (var i = 0; i < nRaw; i++) {
    var off = u64(raw, i * 24), size = u64(raw, i * 24 + 8), skipped = off % RVZ_BLOCK;
    this.raws.push({ off: off - skipped, size: size + skipped, gidx: u32(raw, i * 24 + 16) });
  }
  this.groups = [];
  for (i = 0; i < nGrp; i++) this.groups.push([u32(grp, i * 12), u32(grp, i * 12 + 4), u32(grp, i * 12 + 8)]);
  var id = "";
  for (i = 0; i < 6; i++) id += String.fromCharCode(this.dhead[i]);
  return { gameId: id, isoSize: this.isoSize };
};

RvzReader.prototype.table = async function (off, size) {
  var b = await this.readAt(off, size);
  return this.zstd ? fzstd.decompress(b) : b;
};

/* Dữ liệu một nhóm (chunk) đã giải nén, dài `expected` byte, bắt đầu ở `dataOffset` trên đĩa. */
RvzReader.prototype.group = async function (gidx, expected, dataOffset) {
  if (this.cache.has(gidx)) return this.cache.get(gidx);
  var g = this.groups[gidx], compressed = (g[1] & 0x80000000) !== 0, size = g[1] & 0x7FFFFFFF, packed = g[2];
  var out;
  if (size === 0) out = new Uint8Array(expected);
  else {
    var raw = await this.readAt(g[0] * 4, size);
    if (compressed) raw = fzstd.decompress(raw);
    if (packed) {
      out = new Uint8Array(expected);
      var p = 0, n = 0;
      while (n < expected && p < raw.length) {
        var len = u32(raw, p);
        p += 4;
        if (len & 0x80000000) {                       // đoạn đệm: hạt giống 68 byte, sinh lại
          len = len & 0x7FFFFFFF;
          var lfg = new RvzLfg(raw.subarray(p, p + 68));
          lfg.skip((dataOffset + n) % RVZ_BLOCK);
          lfg.take(out, n, len);
          p += 68;
        } else {
          out.set(raw.subarray(p, p + len), n);
          p += len;
        }
        n += len;
      }
    } else out = raw;
  }
  if (this.cache.size > 96) this.cache.clear();
  this.cache.set(gidx, out);
  return out;
};

/* Đọc `size` byte của ISO gốc từ vị trí `pos`. */
RvzReader.prototype.read = async function (pos, size) {
  var out = new Uint8Array(size), at = 0, end = pos + size;
  while (pos < end) {
    if (pos < 0x80) {
      var t = Math.min(end, 0x80) - pos;
      out.set(this.dhead.subarray(pos, pos + t), at);
      pos += t; at += t;
      continue;
    }
    var r = null;
    for (var i = 0; i < this.raws.length; i++)
      if (this.raws[i].off <= pos && pos < this.raws[i].off + this.raws[i].size) { r = this.raws[i]; break; }
    if (!r) throw new Error("RVZ hỏng: vị trí 0x" + pos.toString(16) + " không có dữ liệu");
    var rel = pos - r.off, gi = Math.floor(rel / this.chunk), inChunk = rel % this.chunk;
    var len = Math.min(this.chunk, r.size - gi * this.chunk);
    var data = await this.group(r.gidx + gi, len, r.off + gi * this.chunk);
    var take = Math.min(end - pos, len - inChunk);
    out.set(data.subarray(inChunk, inChunk + take), at);
    pos += take; at += take;
  }
  return out;
};

if (typeof module !== "undefined") module.exports = { RvzReader: RvzReader };
