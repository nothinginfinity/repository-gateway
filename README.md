# Repository Gateway

A black-box UI on top of the FSL compression backend (`afo-fsl-compress-mcp`).
Paste a public GitHub repo, get a chat workspace with spatial awareness of
the codebase in seconds.

## Why this is a single file

The original spec called for a Next.js app (types, a state context, a
coordinate-citation parser, a full dual-panel layout). The deploy tools
available for this project only push single-script Cloudflare Workers - no
static asset bundle upload, no Pages direct-upload. Rather than deploy
something that would load with no CSS/JS, this is a from-scratch port of the
same product into one dependency-free Worker: inline HTML/CSS/vanilla JS,
server-side chat route, no build step required.

## Architecture (all in `worker.js`)

- `pageHtml()` / `CSS` / `CLIENT_JS` - the entire frontend, inlined.
- Client JS implements the same state machine, manifest parser, and
  coordinate-citation chip renderer as the Next.js reference, in plain JS
  with a tiny `h()` hyperscript helper instead of React.
- `handleChat()` - server-side route. Calls Claude with the manifest as
  system context and a real `decompress_chunk_range` tool against the FSL
  worker, via raw `fetch` to the Anthropic Messages API (no SDK, so it stays
  a single file with zero dependencies).
- Mobile-first: the structure/signals panel is a slide-over drawer on narrow
  screens instead of a second column, since this was built for iPhone use.

## Deploy

```bash
# via Cloudflare dashboard: Workers & Pages -> Create -> paste worker.js
# or via wrangler:
wrangler deploy worker.js --name repository-gateway --compatibility-date 2024-11-01
```

Then set the secret:

```bash
wrangler secret put ANTHROPIC_API_KEY --name repository-gateway
```

## Verified before deploy

- Outer module: `node --check` clean
- Client JS: extracted via real JS evaluation (not regex) and `node --check`'d separately
- Manifest parser: tested against a real live `.v4readme` from the deployed FSL worker - header, codex, tree, and matrix all parse correctly, including both coordinate formats (`[cN]` file-level and `[cN:Lstart-Lend]` keyword-level)
- Full render cycle (intake -> workspace -> signals tab -> tree tab): tested in jsdom against real backend response shapes
- Click-to-expand/collapse: tested via real DOM click events end-to-end, including the error path when decompression fails
- `parseGitHubUrl`: tested against full URLs, `/tree/branch` URLs, owner/repo shorthand, and invalid input

## Not verified

- The live chat round-trip against the real Anthropic API (no key in the
  build sandbox) - test this first after setting `ANTHROPIC_API_KEY`.
