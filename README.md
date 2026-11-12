# vision-mcp

An MCP server that gives your coding agent eyes **without the agent looking at images itself**.
Screenshots and images are sent to OpenAI with a prompt and only the text answer comes back. A
companion hook can switch off the agent's own image reading entirely, and a non-AI pixel diff
answers "did anything change?" for free.

Written in **aowl** (built with aowlmony) on the aoughwl stack: [`mcp`](https://github.com/aoughwl/mcp)
for the protocol, [`openai`](https://github.com/aoughwl/openai) for the API call,
[`requests`](https://github.com/aoughwl/requests) on its native `tcp → net → tls` backend, `jsonref`, and a
from-scratch `zlib` for PNG. No Node, no curl, no C libraries beyond OpenSSL 3.

## Tools

| tool | does |
|---|---|
| `vision_describe` | One image (local path, http(s) URL or data URI) plus a prompt → OpenAI's answer. `detail` (`low`/`high`/`auto`), `model`, `max_tokens`, `reasoning_effort`. |
| `vision_compare` | Up to 8 images in one request ("image 1 is expected, image 2 is actual: list the differences"). |
| `image_diff` | **No AI.** Pixel-exact comparison of two images: % of pixels differing, mean error, PSNR, max channel delta, bounding box of all changes, the largest changed regions as `x,y,w,h`, and a text heatmap. `tolerance` ignores compression noise, `ignore` rectangles mask clocks/FPS counters, `output` writes a diff PNG (changes in red). PNG is decoded natively; JPG/GIF/BMP go through Windows System.Drawing. |
| `vision_claude_images` | Turn the block on the agent's own image reading on/off, or report its state. |

Suggested loop for UI work: `image_diff` against a baseline first (free, instant). Only when something
changed, ask `vision_describe` about the changed region or the diff image.

## Build

Needs aowlmony with aowlsem + aowlhexer, and OpenSSL 3 at runtime. The dependencies are path deps in
`mony.toml`, expected as siblings of this folder (`../aowlmcp` = aoughwl/mcp, `../aoughwl-git/{openai,tcp,net,tls}`,
`../jsonref`, `../requests`, `../zlib`); edit the paths to match your checkout.

```
aowlmony build src/vision.aowl -o bin/vision-mcp.exe
aowlmony build src/block-images.aowl -o bin/block-images.exe
```

## Install (Claude Code)

```
claude mcp add --scope user openai-vision -e OPENAI_API_KEY=sk-... -- /path/to/bin/vision-mcp.exe
```

The key lives only in the MCP server's environment (Claude's user config). It is never written to
this repo or logged. Optional environment: `OPENAI_VISION_MODEL` (default `gpt-5.4-mini`), `OPENAI_BASE_URL`,
`OPENAI_VISION_FLAG`.

### Disable Claude's own image reading

`block-images` is a `PreToolUse` hook. While the flag file `~/.claude/openai-vision.enabled` exists it
refuses `Read` of image files (png, jpg, gif, webp, bmp, tiff, ico, heic, avif) and any MCP
screenshot-style tool (names containing screenshot, computer, zoom, gif_creator, take_snapshot),
telling the agent to use `vision_describe` instead. Add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Read|mcp__.*",
        "hooks": [ { "type": "command", "command": "/path/to/bin/block-images.exe" } ] }
    ]
  }
}
```

Then `vision_claude_images {enabled: true}` creates the flag (blocked) and `{enabled: false}` removes it
(allowed). It takes effect immediately, no restart.

Limits: an image pasted or dragged straight into the prompt is already in the conversation before any
hook runs, and built-in tools that return image content on their own cannot be intercepted generically.

## Notes

- Images over 20 MB are refused. Costs are OpenAI tokens at the chosen model; `detail: low` is cheapest.
- `image_diff` compares the overlapping top-left area when sizes differ and says so (or fails with
  `size_mismatch: "fail"`). Interlaced PNGs are not supported.
- Treat any API key pasted into a chat as exposed and rotate it when convenient.
