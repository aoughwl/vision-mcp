'use strict';
// Non-AI image diff: PNG decode/encode with zlib only. Other formats (jpg/gif/bmp/webp) are converted
// to PNG through Windows PowerShell + System.Drawing first.
const fs = require('fs'), os = require('os'), path = require('path'), zlib = require('zlib'), cp = require('child_process');

const crcTable = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (b) => { let r = 0xffffffff; for (let i = 0; i < b.length; i++) r = crcTable[(r ^ b[i]) & 255] ^ (r >>> 8); return (r ^ 0xffffffff) >>> 0; };

function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let p = 8, w, h, depth, ctype, interlace, plte = null, trns = null; const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), type = buf.toString('latin1', p + 4, p + 8), d = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); depth = d[8]; ctype = d[9]; interlace = d[12]; }
    else if (type === 'PLTE') plte = d; else if (type === 'tRNS') trns = d; else if (type === 'IDAT') idat.push(d);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (interlace) throw new Error('interlaced PNG not supported');
  const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ctype];
  const bpp = Math.max(1, (ch * depth) >> 3), stride = (w * ch * depth + 7) >> 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const px = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[dst + x - bpp] : 0, b = y ? px[dst - stride + x] : 0, c = x >= bpp && y ? px[dst - stride + x - bpp] : 0;
      let v = raw[src + x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      px[dst + x] = v & 255;
    }
  }
  const out = Buffer.alloc(w * h * 4);
  const sample = (row, i) => depth === 8 ? px[row + i] : depth === 16 ? px[row + i * 2] : (px[row + ((i * depth) >> 3)] >> (8 - depth - ((i * depth) & 7))) & ((1 << depth) - 1);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const row = y * stride, o = (y * w + x) * 4; let r, g, b, a = 255;
    if (ctype === 6) { const q = row + x * 4 * (depth >> 3); r = px[q]; g = px[q + (depth >> 3)]; b = px[q + 2 * (depth >> 3)]; a = px[q + 3 * (depth >> 3)]; }
    else if (ctype === 2) { const q = row + x * 3 * (depth >> 3); r = px[q]; g = px[q + (depth >> 3)]; b = px[q + 2 * (depth >> 3)]; }
    else if (ctype === 0) { let s = sample(row, x); if (depth < 8) s = Math.round(s * 255 / ((1 << depth) - 1)); r = g = b = s; }
    else if (ctype === 4) { r = g = b = px[row + x * 2 * (depth >> 3)]; a = px[row + x * 2 * (depth >> 3) + (depth >> 3)]; }
    else { const i = sample(row, x); r = plte[i * 3]; g = plte[i * 3 + 1]; b = plte[i * 3 + 2]; if (trns && i < trns.length) a = trns[i]; }
    out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = a;
  }
  return { w, h, data: out };
}

function encodePng(w, h, rgba) {
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td)); return Buffer.concat([l, td, c]); };
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function loadImage(file) {
  let buf;
  try { buf = fs.readFileSync(file); } catch { throw new Error(`cannot read ${file}`); }
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50) return decodePng(buf);
  // anything else System.Drawing can open -> temp PNG
  const tmp = path.join(os.tmpdir(), `imgdiff-${process.pid}-${Date.now()}.png`);
  const script = `Add-Type -AssemblyName System.Drawing;$i=[System.Drawing.Image]::FromFile($env:IMGDIFF_IN);$b=New-Object System.Drawing.Bitmap($i);$b.Save($env:IMGDIFF_OUT,[System.Drawing.Imaging.ImageFormat]::Png);$b.Dispose();$i.Dispose()`;
  const r = cp.spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { env: { ...process.env, IMGDIFF_IN: file, IMGDIFF_OUT: tmp }, timeout: 30000, windowsHide: true });
  if (r.status !== 0 || !fs.existsSync(tmp)) throw new Error(`cannot decode ${file} (not a PNG, and conversion failed)`);
  try { return decodePng(fs.readFileSync(tmp)); } finally { try { fs.unlinkSync(tmp); } catch {} }
}

// opts: tolerance (0-255 per channel), ignore [{x,y,w,h}], grid [cols,rows], output, size_mismatch 'crop'|'fail'
function diffImages(fa, fb, opts = {}) {
  const A = loadImage(fa), B = loadImage(fb);
  const tol = opts.tolerance || 0;
  const mismatch = A.w !== B.w || A.h !== B.h;
  if (mismatch && opts.size_mismatch === 'fail') throw new Error(`size differs: ${A.w}x${A.h} vs ${B.w}x${B.h}`);
  const w = Math.min(A.w, B.w), h = Math.min(A.h, B.h), total = w * h;
  const ign = (opts.ignore || []);
  const isIgnored = (x, y) => ign.some((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);
  const [gc, gr] = opts.grid || [16, 9];
  const cell = new Float64Array(gc * gr), cellN = new Float64Array(gc * gr);
  const out = Buffer.alloc(w * h * 4);
  let diff = 0, compared = 0, sumAbs = [0, 0, 0], sumSq = 0, maxD = 0, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, alphaDiff = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const ia = (y * A.w + x) * 4, ib = (y * B.w + x) * 4, o = (y * w + x) * 4;
    const gcI = Math.min(gc - 1, Math.floor(x * gc / w)) + Math.min(gr - 1, Math.floor(y * gr / h)) * gc;
    if (ign.length && isIgnored(x, y)) { out[o] = out[o + 1] = out[o + 2] = 40; out[o + 3] = 255; continue; }
    compared++; cellN[gcI]++;
    const dr = Math.abs(A.data[ia] - B.data[ib]), dg = Math.abs(A.data[ia + 1] - B.data[ib + 1]), db = Math.abs(A.data[ia + 2] - B.data[ib + 2]), da = Math.abs(A.data[ia + 3] - B.data[ib + 3]);
    const m = Math.max(dr, dg, db, da);
    sumAbs[0] += dr; sumAbs[1] += dg; sumAbs[2] += db; sumSq += dr * dr + dg * dg + db * db;
    if (m > maxD) maxD = m;
    if (m > tol) {
      diff++; cell[gcI]++; if (da > tol) alphaDiff++;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      out[o] = 255; out[o + 1] = 0; out[o + 2] = 0; out[o + 3] = 255;
    } else { const g = Math.round((A.data[ia] + A.data[ia + 1] + A.data[ia + 2]) / 3 * 0.35 + 140 * 0.65 * 0 + 0); out[o] = out[o + 1] = out[o + 2] = g; out[o + 3] = 255; }
  }
  // clusters: flood-fill grid cells with >0.5% differing pixels, 8-connected
  const hot = (i) => cellN[i] > 0 && cell[i] / cellN[i] > 0.005, seen = new Uint8Array(gc * gr), clusters = [];
  for (let i = 0; i < gc * gr; i++) {
    if (seen[i] || !hot(i)) continue;
    const stack = [i]; seen[i] = 1; let cx0 = gc, cy0 = gr, cx1 = -1, cy1 = -1, px = 0, cells = 0;
    while (stack.length) {
      const c = stack.pop(), cx = c % gc, cy = (c / gc) | 0; cells++; px += cell[c];
      cx0 = Math.min(cx0, cx); cx1 = Math.max(cx1, cx); cy0 = Math.min(cy0, cy); cy1 = Math.max(cy1, cy);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const nx = cx + dx, ny = cy + dy; if (nx < 0 || ny < 0 || nx >= gc || ny >= gr) continue; const n = nx + ny * gc; if (!seen[n] && hot(n)) { seen[n] = 1; stack.push(n); } }
    }
    clusters.push({ x: Math.floor(cx0 * w / gc), y: Math.floor(cy0 * h / gr), w: Math.ceil((cx1 + 1) * w / gc) - Math.floor(cx0 * w / gc), h: Math.ceil((cy1 + 1) * h / gr) - Math.floor(cy0 * h / gr), diff_pixels: px, cells });
  }
  clusters.sort((p, q) => q.diff_pixels - p.diff_pixels);
  const mse = compared ? sumSq / (compared * 3) : 0;
  let outPath = null;
  if (opts.output) { fs.mkdirSync(path.dirname(path.resolve(opts.output)), { recursive: true }); fs.writeFileSync(opts.output, encodePng(w, h, out)); outPath = opts.output; }
  const heat = [];
  for (let r = 0; r < gr; r++) { let line = ''; for (let c = 0; c < gc; c++) { const i = r * gc + c, f = cellN[i] ? cell[i] / cellN[i] : 0; line += f === 0 ? '.' : f < 0.01 ? '1' : f < 0.05 ? '2' : f < 0.2 ? '3' : f < 0.5 ? '5' : '9'; } heat.push(line); }
  return {
    a: { w: A.w, h: A.h }, b: { w: B.w, h: B.h }, size_mismatch: mismatch, compared_size: { w, h },
    compared_pixels: compared, different_pixels: diff, percent_different: compared ? +(diff * 100 / compared).toFixed(4) : 0,
    identical: diff === 0 && !mismatch, alpha_differences: alphaDiff, max_channel_diff: maxD,
    mean_abs_diff_rgb: sumAbs.map((s) => +(s / Math.max(1, compared)).toFixed(3)),
    percent_mean_error: +(sumAbs.reduce((p, q) => p + q, 0) / Math.max(1, compared) / 3 / 255 * 100).toFixed(4),
    psnr_db: mse === 0 ? 'inf' : +(10 * Math.log10(255 * 255 / mse)).toFixed(2),
    bounding_box: diff ? { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 } : null,
    regions: clusters.slice(0, opts.max_regions || 8), heatmap: { cols: gc, rows: gr, legend: '. none, 1 <1%, 2 <5%, 3 <20%, 5 <50%, 9 more of the cell differs', rows_text: heat },
    diff_image: outPath,
  };
}
module.exports = { diffImages, loadImage, decodePng, encodePng };
