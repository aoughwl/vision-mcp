#!/usr/bin/env node
// openai-vision-mcp: describes images through OpenAI instead of Claude reading them.
// stdio MCP (newline-delimited JSON-RPC), no dependencies, Node 18+. Key: OPENAI_API_KEY (env only).
// Companion: block-claude-images.js, a PreToolUse hook that refuses Claude's own image reads
// while the flag file ~/.claude/openai-vision.enabled exists. This server owns that flag.
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const env = process.env;
const log = (...a) => process.stderr.write('[openai-vision-mcp] ' + a.join(' ') + '\n');
const MODEL = env.OPENAI_VISION_MODEL || 'gpt-5.4';
const BASE = (env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
const FLAG = env.OPENAI_VISION_FLAG || path.join(os.homedir(), '.claude', 'openai-vision.enabled');
const MAX_BYTES = 20 * 1024 * 1024;
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };

class Fail extends Error {}
const fail = (m) => { throw new Fail(m); };

function sniff(b) {
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b.slice(0, 3).toString() === 'GIF') return 'image/gif';
  if (b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WEBP') return 'image/webp';
  return null;
}

// image: a local path, an http(s) URL, or a data: URI -> value for image_url.url
function toImageUrl(src) {
  if (/^data:image\//i.test(src) || /^https?:\/\//i.test(src)) return src;
  const p = src.replace(/^file:\/+/i, '');
  let st;
  try { st = fs.statSync(p); } catch { fail(`no such image file: ${p}`); }
  if (!st.isFile()) fail(`${p} is not a file`);
  if (st.size > MAX_BYTES) fail(`${p} is ${(st.size / 1048576).toFixed(1)} MB; the limit is 20 MB`);
  const b = fs.readFileSync(p);
  const mime = sniff(b) || MIME[path.extname(p).toLowerCase()] || fail(`${p} is not a PNG, JPEG, GIF or WebP image`);
  return `data:${mime};base64,${b.toString('base64')}`;
}

async function ask({ images, prompt, detail, model, max_tokens, reasoning_effort }) {
  const key = env.OPENAI_API_KEY || fail("OPENAI_API_KEY is not set in this server's environment");
  const content = [{ type: 'text', text: prompt }];
  for (const src of images) content.push({ type: 'image_url', image_url: { url: toImageUrl(src), detail: detail || 'auto' } });
  const body = { model: model || MODEL, messages: [{ role: 'user', content }], max_completion_tokens: max_tokens || 4000 };
  if (reasoning_effort) body.reasoning_effort = reasoning_effort;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 180000);
  let r, j;
  try {
    r = await fetch(BASE + '/chat/completions', { method: 'POST', signal: ctl.signal, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key }, body: JSON.stringify(body) });
    j = await r.json().catch(() => ({}));
  } catch (e) { fail('OpenAI request failed: ' + (e.name === 'AbortError' ? 'timed out after 180s' : e.message)); }
  finally { clearTimeout(timer); }
  if (!r.ok) fail(`OpenAI ${r.status}: ${(j.error && j.error.message) || JSON.stringify(j).slice(0, 400)}`);
  const ch = j.choices && j.choices[0];
  const text = ch && ch.message && ch.message.content;
  if (!text) fail(`no answer (finish_reason ${ch && ch.finish_reason}); try a larger max_tokens or reasoning_effort "low"`);
  const u = j.usage || {};
  return `${text.trim()}\n\n[${j.model || body.model}; ${u.prompt_tokens ?? '?'} in / ${u.completion_tokens ?? '?'} out tokens]`;
}

const T = {};
const tool = (name, description, properties, required, handler) =>
  (T[name] = { name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false }, handler });
const imgP = { type: 'string', description: 'Absolute path to a PNG/JPEG/GIF/WebP file, an http(s) URL, or a data: URI.' };

tool('vision_describe',
  'Send an image (screenshot, photo, diagram) to OpenAI with a prompt and return its answer. Use this instead of reading images yourself. Ask specific questions ("what text is in the error dialog?", "is the HUD overlapping the hotbar?") for the best result.',
  {
    image: imgP,
    prompt: { type: 'string', minLength: 1, maxLength: 8000, description: 'What to find out. Default: a thorough description including all visible text.' },
    detail: { type: 'string', enum: ['low', 'high', 'auto'], description: 'Image resolution: high for small text and dense UIs (default auto).' },
    model: { type: 'string', description: `OpenAI model (default ${MODEL}, env OPENAI_VISION_MODEL).` },
    max_tokens: { type: 'integer', minimum: 100, maximum: 32000, description: 'Answer cap including reasoning (default 4000).' },
    reasoning_effort: { type: 'string', enum: ['minimal', 'low', 'medium', 'high'], description: 'For reasoning models; low is faster and cheaper.' },
  }, ['image'],
  (a) => ask({ ...a, images: [a.image], prompt: a.prompt || 'Describe this image thoroughly. Transcribe all visible text exactly, and note layout, colors, and anything that looks broken or out of place.' }));

tool('vision_compare',
  'Send several images (up to 8) to OpenAI in one request with a prompt, e.g. before/after screenshots or expected vs actual. Images are numbered in the order given.',
  {
    images: { type: 'array', minItems: 1, maxItems: 8, items: imgP },
    prompt: { type: 'string', minLength: 1, maxLength: 8000, description: 'e.g. "Image 1 is expected, image 2 is actual; list every visual difference."' },
    detail: { type: 'string', enum: ['low', 'high', 'auto'] },
    model: { type: 'string' },
    max_tokens: { type: 'integer', minimum: 100, maximum: 32000 },
    reasoning_effort: { type: 'string', enum: ['minimal', 'low', 'medium', 'high'] },
  }, ['images', 'prompt'], (a) => ask(a));

tool('vision_claude_images',
  "Turn the block on Claude's own image reading on or off (or query it). While ON, the block-claude-images hook refuses Claude's Read of image files and screenshot tools, so images must go through vision_describe. Takes effect immediately, no restart.",
  { enabled: { type: 'boolean', description: 'true: block Claude image reads; false: allow them. Omit to just report.' } }, [],
  (a) => {
    if (a.enabled === true) { fs.mkdirSync(path.dirname(FLAG), { recursive: true }); fs.writeFileSync(FLAG, 'openai-vision-mcp: Claude image reading blocked while this file exists\n'); }
    else if (a.enabled === false) { try { fs.unlinkSync(FLAG); } catch {} }
    const on = fs.existsSync(FLAG);
    return `Claude image reading is ${on ? 'BLOCKED (use vision_describe)' : 'ALLOWED'}. flag: ${FLAG}. model: ${MODEL}. key: ${env.OPENAI_API_KEY ? 'set' : 'MISSING'}.`;
  });

tool('image_diff',
  'Pixel-exact, non-AI comparison of two screenshots/images. Reports overall % of pixels that differ, mean error, PSNR, max channel delta, bounding box of all changes, the largest changed regions (x,y,w,h), and a text heatmap of where differences concentrate. Optionally writes a diff PNG (changed pixels red on a dimmed copy). Free and instant; use it first, then vision_describe on a region/diff image only if you need to know what changed. PNG natively; JPG/GIF/BMP via Windows System.Drawing.',
  {
    a: { type: 'string', description: 'Absolute path of the first (baseline/expected) image.' },
    b: { type: 'string', description: 'Absolute path of the second (actual) image.' },
    tolerance: { type: 'integer', minimum: 0, maximum: 255, description: 'Per-channel difference (0-255) up to which a pixel counts as the same; use 2-8 to ignore compression/antialiasing noise (default 0).' },
    ignore: { type: 'array', maxItems: 50, description: 'Rectangles to exclude (clocks, FPS counters): [{x,y,w,h}] in pixels.', items: { type: 'object', properties: { x: { type: 'integer' }, y: { type: 'integer' }, w: { type: 'integer' }, h: { type: 'integer' } }, required: ['x', 'y', 'w', 'h'] } },
    grid_cols: { type: 'integer', minimum: 1, maximum: 64, description: 'Heatmap columns (default 16).' },
    grid_rows: { type: 'integer', minimum: 1, maximum: 64, description: 'Heatmap rows (default 9).' },
    size_mismatch: { type: 'string', enum: ['crop', 'fail'], description: 'If dimensions differ: compare the overlapping top-left area and say so (default crop), or fail.' },
    output: { type: 'string', description: 'Where to write the diff PNG (absolute path). Omit for stats only.' },
    max_regions: { type: 'integer', minimum: 1, maximum: 50 },
  }, ['a', 'b'],
  (a) => {
    let r;
    try { r = require('./imgdiff').diffImages(a.a, a.b, { tolerance: a.tolerance, ignore: a.ignore, grid: [a.grid_cols || 16, a.grid_rows || 9], size_mismatch: a.size_mismatch, output: a.output, max_regions: a.max_regions }); }
    catch (e) { fail(e.message); }
    const head = r.identical ? 'IDENTICAL' : `${r.percent_different}% of pixels differ (${r.different_pixels} of ${r.compared_pixels})`;
    return `${head}${r.size_mismatch ? `\nWARNING sizes differ (${r.a.w}x${r.a.h} vs ${r.b.w}x${r.b.h}); compared the overlapping ${r.compared_size.w}x${r.compared_size.h} top-left area` : ''}\n` + JSON.stringify(r, null, 1);
  });

// ---- protocol ----
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
async function handle(msg) {
  if (!msg || typeof msg.method !== 'string') return;
  const note = msg.id === undefined || msg.id === null;
  const reply = (result) => { if (!note) send({ jsonrpc: '2.0', id: msg.id, result }); };
  const err = (code, message) => { if (!note) send({ jsonrpc: '2.0', id: msg.id, error: { code, message } }); };
  switch (msg.method) {
    case 'initialize': return reply({ protocolVersion: (msg.params && msg.params.protocolVersion) || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'openai-vision', version: '0.1.0' } });
    case 'ping': return reply({});
    case 'tools/list': return reply({ tools: Object.values(T).map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case 'tools/call': {
      const t = T[msg.params && msg.params.name];
      if (!t) return err(-32602, 'unknown tool');
      try {
        const args = msg.params.arguments || {};
        for (const r of t.inputSchema.required) if (args[r] === undefined) fail(`missing parameter '${r}'`);
        for (const k of Object.keys(args)) if (!t.inputSchema.properties[k]) fail(`unknown parameter '${k}'`);
        return reply({ content: [{ type: 'text', text: String(await t.handler(args)) }] });
      } catch (e) {
        if (!(e instanceof Fail)) log(e.stack);
        return reply({ isError: true, content: [{ type: 'text', text: (e instanceof Fail ? '' : 'internal error: ') + e.message }] });
      }
    }
    default: return note ? undefined : err(-32601, 'method not found: ' + msg.method);
  }
}
let buf = '', pending = 0, ended = false;
const done = () => { if (ended && !pending) process.exit(0); };
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d; let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!l) continue;
    let m; try { m = JSON.parse(l); } catch { continue; }
    pending++; handle(m).catch((e) => log(e.stack)).finally(() => { pending--; done(); });
  }
});
process.stdin.on('end', () => { ended = true; done(); });
log(`ready (model ${MODEL})`);
