#!/usr/bin/env node
// PreToolUse hook: while ~/.claude/openai-vision.enabled exists, refuse Claude reading images itself.
// Covers Read on image files and screenshot-style MCP tools; the vision MCP is the replacement.
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const flag = process.env.OPENAI_VISION_FLAG || path.join(os.homedir(), '.claude', 'openai-vision.enabled');
let raw = '';
process.stdin.on('data', (d) => (raw += d));
process.stdin.on('end', () => {
  if (!fs.existsSync(flag)) return process.exit(0);
  let e; try { e = JSON.parse(raw); } catch { return process.exit(0); }
  const tool = e.tool_name || '', inp = e.tool_input || {};
  const IMG = /\.(png|jpe?g|gif|webp|bmp|tiff?|ico|heic|avif)$/i;
  let why = null;
  if (tool === 'Read' && IMG.test(String(inp.file_path || ''))) why = `Read of image ${inp.file_path}`;
  else if (/^mcp__/.test(tool) && !/openai-vision/.test(tool) && /screenshot|computer|zoom|gif_creator|take_snapshot/i.test(tool)) why = `screenshot tool ${tool}`;
  if (!why) return process.exit(0);
  process.stderr.write(`Blocked (${why}): Claude's own image reading is disabled while the OpenAI vision MCP is enabled. Use mcp__openai-vision__vision_describe with the image path and a specific prompt instead (vision_compare for several images). To re-allow: mcp__openai-vision__vision_claude_images {enabled:false}.\n`);
  process.exit(2);
});
