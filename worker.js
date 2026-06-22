const VERSION = "1.0.0";
const FSL_WORKER = "https://afo-fsl-compress-mcp.jaredtechfit.workers.dev";
const MODEL = "claude-sonnet-4-6";
const MAX_TOOL_ROUNDS = 4;
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

function decompressTool() {
  return {
    name: "decompress_chunk_range",
    description:
      "Read exact source lines from the repository when the manifest's keyword matches aren't enough to answer precisely. " +
      "chunkId is the short positional id from the manifest tree/matrix (e.g. 'c12'). " +
      "Always prefer a tight line range; only omit lineStart/lineEnd if you genuinely need the whole file.",
    input_schema: {
      type: "object",
      properties: {
        chunkId: { type: "string", description: "Positional chunk id, e.g. 'c12'." },
        lineStart: { type: "integer", description: "First line to read (1-indexed, inclusive)." },
        lineEnd: { type: "integer", description: "Last line to read (1-indexed, inclusive)." },
      },
      required: ["chunkId"],
    },
  };
}

function systemPrompt(manifest, repoKey) {
  return [
    `You are the embedded code assistant for the repository "${repoKey}", speaking inside a product called Repository Gateway.`,
    `You have NOT loaded the repository's full source. Instead you have its .v4readme manifest below - a compressed spatial index: a header with stats, a dash-codex that expands path shorthand, a file tree where each file has a coordinate like [c12:b1854], and a semantic matrix mapping keywords/signals to coordinates like div->[c12:L54-64].`,
    ``,
    `Ground every answer in the manifest first. When you state something about a specific file or line range, cite it inline using the exact coordinate grammar the manifest uses: [cN] for a whole-file/file-level signal, or [cN:Lstart-Lend] for a specific range - e.g. "the handler at workers/admin.js [c12:L142-152]". The product UI turns these citations into clickable, expandable code panels for the user, so always cite this way rather than describing a location in prose alone.`,
    ``,
    `If the manifest's keyword matches don't give you enough to answer precisely - exact logic, a specific condition, an exact value - call decompress_chunk_range to read the real lines before answering. Keep ranges tight. After reading, still cite the coordinate in your final answer so the user can see it themselves.`,
    ``,
    `Be direct and specific. Don't narrate that you're "checking the manifest" - just answer, citing coordinates naturally as part of the sentence.`,
    ``,
    `--- .v4readme ---`,
    manifest,
    `--- end .v4readme ---`,
  ].join("\n");
}

async function handleChat(request, env) {
  if (!env.ANTHROPIC_API_KEY) {
    return json({ ok: false, error: "ANTHROPIC_API_KEY is not configured on the server." }, 500);
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }
  const repo = body && body.repo;
  const manifest = body && body.manifest;
  const messages = body && body.messages;
  if (!repo || !repo.owner || !repo.repo || !manifest || !Array.isArray(messages) || messages.length === 0) {
    return json({ ok: false, error: "repo, manifest, and messages are required." }, 400);
  }

  const repoKey = repo.owner + "/" + repo.repo;
  const conversation = messages.map((m) => ({ role: m.role, content: m.content }));

  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 1024,
          system: systemPrompt(manifest, repoKey),
          tools: [decompressTool()],
          messages: conversation,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        const msg = (data && data.error && data.error.message) || "Anthropic API error " + res.status;
        return json({ ok: false, error: msg }, 500);
      }

      const content = data.content || [];
      const toolUses = content.filter((b) => b.type === "tool_use");

      if (toolUses.length === 0 || data.stop_reason !== "tool_use") {
        const text = content
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("\n")
          .trim();
        return json({ ok: true, reply: text || "I don't have anything to add." });
      }

      conversation.push({ role: "assistant", content });

      const toolResults = await Promise.all(
        toolUses.map(async (call) => {
          const input = call.input || {};
          if (!input.chunkId) {
            return { type: "tool_result", tool_use_id: call.id, content: "Error: chunkId is required.", is_error: true };
          }
          try {
            const r = await fetch(FSL_WORKER + "/api/decompress_chunk", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                owner: repo.owner,
                repo: repo.repo,
                branch: repo.branch || "main",
                chunkId: input.chunkId,
                lineStart: input.lineStart,
                lineEnd: input.lineEnd,
                full: input.lineStart === undefined && input.lineEnd === undefined,
              }),
            });
            const d = await r.json();
            if (!r.ok || d.ok === false) {
              return { type: "tool_result", tool_use_id: call.id, content: "Error: " + (d.error || "decompression failed"), is_error: true };
            }
            return {
              type: "tool_result",
              tool_use_id: call.id,
              content: "path: " + d.path + "\nlines " + d.lineStart + "-" + d.lineEnd + ":\n" + d.text,
            };
          } catch (e) {
            return { type: "tool_result", tool_use_id: call.id, content: "Error: " + e.message, is_error: true };
          }
        })
      );

      conversation.push({ role: "user", content: toolResults });
    }

    return json({ ok: false, error: "The assistant made too many tool calls without reaching an answer." }, 500);
  } catch (e) {
    return json({ ok: false, error: e.message || "Unexpected error calling the model." }, 500);
  }
}

function pageHtml() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Repository Gateway</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>${CSS}</style>
</head>
<body>
<div id="root"></div>
<script>${CLIENT_JS}</script>
</body>
</html>`;
}

const CSS = `
:root{ --cyan:#22d3ee; --amber:#fbbf24; }
*{box-sizing:border-box;}
html,body{margin:0;padding:0;background:#020617;color:#e2e8f0;height:100%;}
body{font-family:'Inter',ui-sans-serif,system-ui,sans-serif;-webkit-font-smoothing:antialiased;}
#root{min-height:100vh;}
.mono{font-family:'IBM Plex Mono',ui-monospace,monospace;}
button{font-family:inherit;cursor:pointer;}
:focus-visible{outline:2px solid rgba(34,211,238,.6);outline-offset:2px;}
@media (prefers-reduced-motion: reduce){*,*::before,*::after{animation-duration:.001ms!important;transition-duration:.001ms!important;}}

/* ---------- Intake screen ---------- */
.intake-screen{position:relative;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;overflow:hidden;}
.ambient{position:absolute;inset:0;pointer-events:none;}
.ambient .glow{position:absolute;left:50%;top:32%;width:560px;height:560px;margin-left:-280px;margin-top:-280px;border-radius:50%;background:rgba(34,211,238,0.06);filter:blur(100px);}
.ambient .grid{position:absolute;inset:0;background-image:radial-gradient(circle at 1px 1px, rgba(255,255,255,0.035) 1px, transparent 0);background-size:24px 24px;}
.intake-inner{position:relative;z-index:1;width:100%;max-width:560px;display:flex;flex-direction:column;align-items:center;}
.eyebrow{display:flex;align-items:center;gap:8px;font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:rgba(34,211,238,.7);margin-bottom:12px;}
.dot{width:6px;height:6px;border-radius:50%;background:var(--cyan);box-shadow:0 0 8px 2px rgba(34,211,238,.8);}
h1.title{font-family:'IBM Plex Mono',monospace;font-size:32px;font-weight:500;letter-spacing:-.01em;color:#f1f5f9;text-align:center;margin:0;}
p.subtitle{margin:12px 0 0;font-size:14px;color:#64748b;text-align:center;}
.intake-form{width:100%;margin-top:40px;}
.intake-bar{position:relative;display:flex;align-items:center;gap:8px;border-radius:12px;border:1px solid #1e293b;background:rgba(15,23,42,.6);backdrop-filter:blur(8px);padding:12px 16px;transition:all .3s;}
.intake-bar:focus-within{border-color:rgba(34,211,238,.5);box-shadow:0 0 30px -10px rgba(34,211,238,.4);}
.intake-bar--loading{border-color:rgba(34,211,238,.4);box-shadow:0 0 30px -8px rgba(34,211,238,.5);}
.prompt-caret{font-family:'IBM Plex Mono',monospace;color:#475569;}
.intake-input{flex:1;min-width:0;background:transparent;border:none;color:#e2e8f0;font-family:'IBM Plex Mono',monospace;font-size:14px;}
.intake-input::placeholder{color:#475569;}
.intake-input:focus{outline:none;}
.btn-primary{display:flex;align-items:center;gap:6px;border-radius:8px;border:1px solid rgba(34,211,238,.4);background:rgba(34,211,238,.1);color:#a5f3fc;font-family:'IBM Plex Mono',monospace;font-size:12px;padding:7px 12px;white-space:nowrap;transition:background .2s;}
.btn-primary:hover{background:rgba(34,211,238,.2);}
.btn-primary:disabled{opacity:.4;cursor:not-allowed;}
.status-area{margin-top:24px;min-height:24px;display:flex;justify-content:center;}
.ticker{display:flex;align-items:center;gap:8px;font-family:'IBM Plex Mono',monospace;font-size:12px;color:rgba(103,232,249,.8);animation:fade-in .2s ease-out;}
.error-text{display:flex;align-items:center;gap:8px;font-family:'IBM Plex Mono',monospace;font-size:12px;color:#fcd34d;}
@keyframes fade-in{from{opacity:0;}to{opacity:1;}}

/* ---------- Workspace shell ---------- */
.workspace{display:flex;flex-direction:column;height:100vh;background:#020617;animation:fade-in .4s ease-out;}
.ws-header{display:flex;align-items:center;justify-content:space-between;gap:12px;border-bottom:1px solid rgba(30,41,59,.8);background:rgba(2,6,23,.8);backdrop-filter:blur(8px);padding:10px 16px;}
.ws-header-left{display:flex;align-items:center;gap:10px;min-width:0;}
.repo-name{font-family:'IBM Plex Mono',monospace;font-size:13px;color:#cbd5e1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.branch-pill{flex-shrink:0;border:1px solid #334155;border-radius:999px;padding:1px 8px;font-family:'IBM Plex Mono',monospace;font-size:11px;color:#64748b;}
.ws-header-right{display:flex;align-items:center;gap:10px;flex-shrink:0;}
.ws-stats{display:none;font-family:'IBM Plex Mono',monospace;font-size:11px;color:#64748b;}
.icon-btn{display:flex;align-items:center;gap:6px;border-radius:6px;border:1px solid #1e293b;background:transparent;color:#94a3b8;font-family:'IBM Plex Mono',monospace;font-size:11px;padding:5px 9px;transition:.2s;}
.icon-btn:hover{border-color:#475569;color:#e2e8f0;}
.ws-panels{display:flex;flex:1;min-height:0;position:relative;}
.chat-panel{display:flex;flex-direction:column;min-width:0;flex:1 1 60%;border-right:1px solid rgba(30,41,59,.8);}
.hud-panel{display:flex;flex-direction:column;min-width:0;flex:1 1 40%;}

@media (max-width: 860px){
  .ws-stats{display:none!important;}
  .chat-panel{flex:1 1 100%;border-right:none;}
  .hud-panel{position:fixed;top:0;right:0;bottom:0;width:88vw;max-width:380px;background:#020617;border-left:1px solid rgba(30,41,59,.9);transform:translateX(100%);transition:transform .25s ease;z-index:20;box-shadow:-20px 0 40px -20px rgba(0,0,0,.6);}
  .hud-panel--open{transform:translateX(0);}
  .hud-scrim{position:fixed;inset:0;background:rgba(2,6,23,.6);z-index:19;display:none;}
  .hud-scrim--open{display:block;}
}
@media (min-width: 861px){
  .ws-stats{display:inline;}
}

/* chat */
.chat-scroll{flex:1;min-height:0;overflow-y:auto;padding:18px 18px 8px;display:flex;flex-direction:column;gap:14px;}
.bubble-row{display:flex;}
.bubble-row--user{justify-content:flex-end;}
.bubble-row--assistant{justify-content:flex-start;}
.bubble{max-width:85%;border-radius:12px;padding:10px 14px;font-size:14px;line-height:1.55;white-space:pre-wrap;}
.bubble--user{background:rgba(30,41,59,.8);color:#f1f5f9;}
.bubble--assistant{border:1px solid #1e293b;background:rgba(15,23,42,.5);color:#cbd5e1;}
.typing{display:flex;gap:4px;align-items:center;}
.typing span{width:6px;height:6px;border-radius:50%;background:#64748b;animation:bounce 1.2s infinite;}
.typing span:nth-child(2){animation-delay:.12s;}
.typing span:nth-child(3){animation-delay:.24s;}
@keyframes bounce{0%,80%,100%{transform:translateY(0);}40%{transform:translateY(-4px);}}
.chat-input-row{border-top:1px solid rgba(30,41,59,.8);padding:10px 14px;}
.chat-input-bar{display:flex;align-items:center;gap:8px;border-radius:10px;border:1px solid #1e293b;background:rgba(15,23,42,.6);padding:9px 12px;}
.chat-input-bar:focus-within{border-color:rgba(34,211,238,.4);}
.chat-input{flex:1;background:transparent;border:none;color:#e2e8f0;font-size:14px;}
.chat-input::placeholder{color:#475569;}
.chat-input:focus{outline:none;}
.send-btn{display:flex;align-items:center;justify-content:center;border:none;background:transparent;color:#67e8f9;padding:6px;border-radius:6px;}
.send-btn:disabled{opacity:.3;}
.send-btn:not(:disabled):hover{background:rgba(34,211,238,.1);}

/* coordinate chip */
.coord-chip{display:inline-flex;align-items:center;gap:5px;margin:0 2px;border-radius:6px;border:1px solid #334155;background:rgba(15,23,42,.6);color:rgba(103,232,249,.9);font-family:'IBM Plex Mono',monospace;font-size:12px;padding:2px 7px;transition:.2s;vertical-align:baseline;}
.coord-chip:hover{border-color:rgba(34,211,238,.5);background:rgba(34,211,238,.05);}
.coord-chip--open{border-color:rgba(34,211,238,.6);background:rgba(34,211,238,.1);box-shadow:0 0 12px -2px rgba(34,211,238,.6);}
.coord-chip .lbl{max-width:11rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.coord-chip .rng{color:#64748b;}
.coord-chip .chev{transition:transform .2s;color:#64748b;}
.coord-chip--open .chev{transform:rotate(90deg);color:#67e8f9;}
.code-panel{display:block;width:100%;max-width:640px;margin:8px 0;border-radius:10px;border:1px solid rgba(34,211,238,.3);background:rgba(2,6,23,.92);box-shadow:0 0 24px -8px rgba(34,211,238,.5);overflow:hidden;animation:seam-open .26s ease-out;}
@keyframes seam-open{0%{opacity:0;transform:scaleY(.4);filter:blur(2px);}60%{opacity:1;transform:scaleY(1.02);filter:blur(0);}100%{opacity:1;transform:scaleY(1);}}
.code-panel-head{display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #1e293b;background:rgba(15,23,42,.8);padding:6px 12px;font-family:'IBM Plex Mono',monospace;font-size:11px;color:#64748b;}
.code-panel-body{max-height:320px;overflow:auto;padding:8px 12px;}
.code-line{display:flex;font-family:'IBM Plex Mono',monospace;font-size:12.5px;line-height:20px;color:#cbd5e1;}
.code-line .n{width:32px;flex-shrink:0;text-align:right;margin-right:12px;color:#475569;user-select:none;}
.code-line .t{flex:1;white-space:pre;}
.code-msg{display:flex;align-items:center;gap:8px;padding:8px 0;font-family:'IBM Plex Mono',monospace;font-size:12px;}
.code-msg.loading{color:#94a3b8;}
.code-msg.error{color:#fcd34d;}
.spin{animation:spin 1s linear infinite;}
@keyframes spin{to{transform:rotate(360deg);}}

/* HUD */
.hud-tabs{display:flex;border-bottom:1px solid rgba(30,41,59,.8);}
.hud-tab{flex:1;display:flex;align-items:center;justify-content:center;gap:6px;border:none;background:transparent;border-bottom:2px solid transparent;color:#64748b;font-family:'IBM Plex Mono',monospace;font-size:11px;text-transform:uppercase;letter-spacing:.05em;padding:10px 6px;}
.hud-tab--active{border-bottom-color:var(--cyan);color:#67e8f9;}
.hud-body{flex:1;min-height:0;overflow-y:auto;padding:14px;}
.hud-empty{font-family:'IBM Plex Mono',monospace;font-size:12px;color:#475569;}
.tree-row{display:flex;align-items:center;gap:6px;width:100%;border:none;background:transparent;text-align:left;padding:5px 6px;border-radius:6px;font-family:'IBM Plex Mono',monospace;font-size:12px;color:#cbd5e1;}
.tree-row:hover{background:rgba(15,23,42,.7);}
.tree-row .grow{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.tree-row .meta{flex-shrink:0;color:#475569;}
.section-label{font-family:'IBM Plex Mono',monospace;font-size:11px;text-transform:uppercase;letter-spacing:.12em;color:#64748b;margin:0 0 8px;}
.signal-card{border:1px solid #1e293b;background:rgba(15,23,42,.4);border-radius:10px;padding:8px 12px;margin-bottom:8px;}
.signal-card-top{display:flex;align-items:center;justify-content:space-between;}
.signal-label{font-family:'IBM Plex Mono',monospace;font-size:12px;color:#e2e8f0;}
.domain-pill{border-radius:999px;font-family:'IBM Plex Mono',monospace;font-size:10px;padding:1px 8px;}
.domain-Runtime{background:rgba(34,211,238,.1);color:#67e8f9;}
.domain-UI{background:rgba(232,121,249,.1);color:#f0abfc;}
.domain-Database{background:rgba(52,211,153,.1);color:#6ee7b7;}
.domain-Routing{background:rgba(251,191,36,.1);color:#fcd34d;}
.domain-Auth{background:rgba(251,113,133,.1);color:#fda4af;}
.signal-bar{height:4px;border-radius:999px;background:#1e293b;margin-top:6px;overflow:hidden;}
.signal-bar-fill{height:100%;border-radius:999px;background:linear-gradient(90deg,#06b6d4,#67e8f9);}
.kw-cloud{display:flex;flex-wrap:wrap;gap:6px;}
.kw-pill{border:1px solid #1e293b;background:rgba(15,23,42,.5);border-radius:999px;font-family:'IBM Plex Mono',monospace;font-size:11px;color:#94a3b8;padding:4px 8px;}
.kw-pill b{color:#475569;font-weight:400;margin-left:2px;}
.stat-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;}
.stat-box{border:1px solid #1e293b;background:rgba(15,23,42,.4);border-radius:10px;padding:8px 10px;font-family:'IBM Plex Mono',monospace;font-size:11px;}
.stat-box .l{color:#475569;}
.stat-box .v{color:#e2e8f0;margin-top:2px;}
`;

const CLIENT_JS = `
const FSL_WORKER = ${JSON.stringify(FSL_WORKER)};
const TICKER_STEPS = ["Fetching Git Tree...","Parsing Semantic Signatures...","Building Path Codex...","Calibrating Coordinate Matrix...","Indexing Signal Vectors..."];

const state = {
  phase: "intake", repo: null, manifest: null, messages: [], isTyping: false,
  errorMessage: null, tickerIndex: 0, listChunks: null, featureVector: null,
  rightTab: "tree", expanded: {}, hudOpen: false, draftUrl: "", draftMsg: "",
};
let tickerHandle = null;
let msgCounter = 0;

function uid(prefix){ msgCounter += 1; return (prefix||"m") + "_" + Date.now().toString(36) + "_" + msgCounter; }

function h(tag, props, children){
  const node = document.createElement(tag);
  props = props || {};
  for (const k of Object.keys(props)){
    const v = props[k];
    if (v == null) continue;
    if (k === "class") node.className = v;
    else if (k.indexOf("on") === 0 && typeof v === "function") node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "disabled") { if (v) node.setAttribute("disabled","true"); }
    else node.setAttribute(k, v);
  }
  (Array.isArray(children) ? children : [children]).forEach((c) => {
    if (c == null) return;
    node.appendChild(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c);
  });
  return node;
}

function fmtBytes(n){
  if (n < 1024) return n + "B";
  if (n < 1024*1024) return (n/1024).toFixed(1) + "KB";
  return (n/(1024*1024)).toFixed(1) + "MB";
}

function parseGitHubUrl(input){
  const trimmed = (input||"").trim();
  let m = /^([\w.-]+)\/([\w.-]+)$/.exec(trimmed);
  if (m) return { owner: m[1], repo: m[2].replace(/\.git$/,"") };
  m = /github\.com\/([^/\s]+)\/([^/\s#?]+)/.exec(trimmed);
  if (m) return { owner: m[1], repo: m[2].replace(/\.git$/,"") };
  return null;
}

const HEADER_RE = /^\u00a7V4README\u00a7([^@]+)@(\S+)\s+fmt:(\S+)/;
const STATS_RE = /sha:(\S+)\s+files:(\d+)\s+raw:(\d+)\s+cmp:(\d+)\s+ratio:([\d.]+)x/;
const TREE_LINE_RE = /^(.*)\s\[c(\d+):b(\d+)\]$/;
const MATRIX_FILE_RE = /^([^->]+)->\[c(\d+)\]$/;
const MATRIX_LINE_RE = /^([^->]+)->\[c(\d+):L(\d+)-(\d+)\]$/;

function expandCodex(compactPath, codex){
  const sorted = codex.slice().sort((a,b) => b.dashCode.length - a.dashCode.length);
  let out = compactPath;
  for (const entry of sorted) out = out.split(entry.dashCode).join(entry.term);
  return out;
}

function parseV4Readme(raw){
  const lines = raw.split("\n");
  const header = { repoKey:"", branch:"", formatVersion:"", sha:"", files:0, rawBytes:0, compressedBytes:0, ratio:0, signals:[] };
  const codex = []; const tree = []; const matrix = [];
  let section = "header"; let currentDomain = "";
  for (const line of lines){
    if (line === "-CODEX-"){ section = "codex"; continue; }
    if (line === "-TREE-"){ section = "tree"; continue; }
    if (line === "-MATRIX-"){ section = "matrix"; continue; }
    if (section === "header"){
      let m = HEADER_RE.exec(line);
      if (m){ header.repoKey=m[1]; header.branch=m[2]; header.formatVersion=m[3]; continue; }
      m = STATS_RE.exec(line);
      if (m){ header.sha=m[1]; header.files=+m[2]; header.rawBytes=+m[3]; header.compressedBytes=+m[4]; header.ratio=+m[5]; continue; }
      if (line.indexOf("signals:") === 0){ header.signals = line.slice(8).split(";").filter(Boolean); continue; }
      continue;
    }
    if (section === "codex"){
      const eq = line.indexOf("=");
      if (eq > 0) codex.push({ dashCode: line.slice(0,eq), term: line.slice(eq+1) });
      continue;
    }
    if (section === "tree"){
      const m = TREE_LINE_RE.exec(line);
      if (m){
        const compactPath = m[1];
        tree.push({ compactPath, path: expandCodex(compactPath, codex), chunkId: "c"+m[2], bytes: +m[3] });
      }
      continue;
    }
    if (section === "matrix"){
      const colon = line.indexOf(":");
      if (colon > 0){
        currentDomain = line.slice(0,colon);
        const rest = line.slice(colon+1);
        rest.split(",").forEach((token) => {
          let m = MATRIX_LINE_RE.exec(token);
          if (m){ matrix.push({ domain: currentDomain, keyword:m[1], chunkId:"c"+m[2], lineStart:+m[3], lineEnd:+m[4], raw: token }); return; }
          m = MATRIX_FILE_RE.exec(token);
          if (m){ matrix.push({ domain: currentDomain, keyword:m[1], chunkId:"c"+m[2], raw: token }); }
        });
      }
      continue;
    }
  }
  return { raw, header, codex, tree, matrix };
}

async function asJson(res){
  let body;
  try { body = await res.json(); } catch { throw new Error("The backend returned a non-JSON response."); }
  if (!res.ok || body.ok === false) throw new Error(body.error || ("Request failed with status " + res.status));
  return body;
}

async function compressRepo(url){
  const res = await fetch(FSL_WORKER + "/api/compress_repo", { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ url }) });
  return asJson(res);
}
async function fetchListChunks(repo){
  const qs = new URLSearchParams({ owner: repo.owner, repo: repo.repo, branch: repo.branch });
  return asJson(await fetch(FSL_WORKER + "/api/list_chunks?" + qs.toString()));
}
async function fetchFeatureVector(repo){
  const qs = new URLSearchParams({ owner: repo.owner, repo: repo.repo, branch: repo.branch });
  return asJson(await fetch(FSL_WORKER + "/api/get_feature_vector?" + qs.toString()));
}
async function decompressChunk(repo, chunkId, lineStart, lineEnd){
  const res = await fetch(FSL_WORKER + "/api/decompress_chunk", {
    method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({ owner: repo.owner, repo: repo.repo, branch: repo.branch, chunkId, lineStart, lineEnd, full: lineStart===undefined && lineEnd===undefined })
  });
  return asJson(res);
}

function stopTicker(){ if (tickerHandle){ clearInterval(tickerHandle); tickerHandle = null; } }

async function submitRepoUrl(input){
  const parsed = parseGitHubUrl(input);
  if (!parsed){
    state.phase = "error"; state.errorMessage = "That doesn't look like a GitHub repository. Try owner/repo or a full URL.";
    render(); return;
  }
  const repo = { owner: parsed.owner, repo: parsed.repo, branch: "main" };
  state.phase = "loading"; state.repo = repo; state.errorMessage = null; state.tickerIndex = 0;
  render();
  stopTicker();
  tickerHandle = setInterval(() => { state.tickerIndex += 1; renderTickerOnly(); }, 900);

  try {
    const result = await compressRepo(input.trim());
    const manifest = parseV4Readme(result.manifest);
    const [listChunks, featureVector] = await Promise.all([
      fetchListChunks(repo).catch(() => null),
      fetchFeatureVector(repo).catch(() => null),
    ]);
    state.listChunks = listChunks; state.featureVector = featureVector;
    const topSignals = manifest.header.signals.slice(0,3).join(", ") || "none detected";
    state.messages = [{
      id: uid("a"), role:"assistant",
      content: "I've indexed **" + manifest.header.repoKey + "** \u2014 " + manifest.header.files + " files, " + manifest.header.ratio + "x compression. Top signals: " + topSignals + ".\n\nAsk me anything about the codebase \u2014 I can pull exact lines when I need to look something up.",
      createdAt: Date.now(),
    }];
    state.manifest = manifest; state.phase = "workspace";
  } catch (err) {
    state.phase = "error"; state.errorMessage = err && err.message ? err.message : "Something went wrong reaching the repository brain.";
  } finally {
    stopTicker();
    render();
  }
}

async function sendMessage(text){
  const trimmed = (text||"").trim();
  if (!trimmed || !state.repo || !state.manifest) return;
  const userMsg = { id: uid("u"), role:"user", content: trimmed, createdAt: Date.now() };
  state.messages.push(userMsg); state.isTyping = true; state.draftMsg = "";
  render();
  try {
    const res = await fetch("/api/chat", {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ repo: state.repo, manifest: state.manifest.raw, messages: state.messages.map((m)=>({role:m.role, content:m.content})) })
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || "The assistant couldn't respond.");
    state.messages.push({ id: uid("a"), role:"assistant", content: data.reply, createdAt: Date.now() });
  } catch (err) {
    state.messages.push({ id: uid("a"), role:"assistant", content: "I hit an error: " + (err && err.message ? err.message : "unexpected error"), createdAt: Date.now() });
  } finally {
    state.isTyping = false;
    render();
  }
}

async function toggleChunkExpansion(key, chunkId, lineStart, lineEnd){
  if (state.expanded[key]){ delete state.expanded[key]; render(); return; }
  state.expanded[key] = { status:"loading" };
  render();
  try {
    const data = await decompressChunk(state.repo, chunkId, lineStart, lineEnd);
    state.expanded[key] = { status:"loaded", data };
  } catch (err) {
    state.expanded[key] = { status:"error", message: err && err.message ? err.message : "Couldn't load that range." };
  }
  render();
}

const COORDINATE_RE = /\[c(\d+)(?::L(\d+)-(\d+))?\]/g;

function splitMessage(content){
  const segments = []; let lastIndex = 0; let m;
  const re = new RegExp(COORDINATE_RE);
  while ((m = re.exec(content)) !== null){
    if (m.index > lastIndex) segments.push({ kind:"text", value: content.slice(lastIndex, m.index) });
    segments.push({ kind:"coord", chunkId:"c"+m[1], lineStart: m[2]?+m[2]:undefined, lineEnd: m[3]?+m[3]:undefined, raw: m[0] });
    lastIndex = m.index + m[0].length;
  }
  if (lastIndex < content.length) segments.push({ kind:"text", value: content.slice(lastIndex) });
  return segments;
}

function renderInlineText(value){
  const frag = document.createDocumentFragment();
  value.split(/(\*\*[^*]+\*\*)/g).forEach((part) => {
    if (part.indexOf("**") === 0 && part.lastIndexOf("**") === part.length-2 && part.length > 4){
      frag.appendChild(h("strong", { style:"font-weight:600;color:#f1f5f9;" }, part.slice(2,-2)));
    } else if (part) {
      frag.appendChild(document.createTextNode(part));
    }
  });
  return frag;
}

function renderMessageContent(content, messageId){
  const wrap = h("span", {});
  splitMessage(content).forEach((seg, i) => {
    if (seg.kind === "text") wrap.appendChild(renderInlineText(seg.value));
    else wrap.appendChild(renderCoordChip(seg, messageId, i));
  });
  return wrap;
}

function renderCoordChip(token, messageId, index){
  const key = messageId + ":" + index + ":" + token.raw;
  const expansion = state.expanded[key];
  const isOpen = !!expansion;
  const treeEntry = state.manifest && state.manifest.tree.find((t) => t.chunkId === token.chunkId);
  const label = treeEntry ? treeEntry.path : token.chunkId;
  const rangeLabel = (token.lineStart && token.lineEnd) ? ("L"+token.lineStart+"-"+token.lineEnd) : "full";

  const container = h("span", { style:"display:inline-block;" });
  const chip = h("button", {
    type:"button", class:"coord-chip" + (isOpen ? " coord-chip--open" : ""), title: label + " - " + rangeLabel,
    onclick: () => toggleChunkExpansion(key, token.chunkId, token.lineStart, token.lineEnd),
  }, [
    h("span", { class:"lbl" }, label),
    h("span", { class:"rng" }, rangeLabel),
    h("span", { class:"chev" }, "\u203a"),
  ]);
  container.appendChild(chip);
  if (expansion) container.appendChild(renderExpandedPanel(expansion, label));
  return container;
}

function renderExpandedPanel(expansion, label){
  const head = h("div", { class:"code-panel-head" }, [
    h("span", {}, label),
    expansion.status === "loaded" ? h("span", {}, "L"+expansion.data.lineStart+"-"+expansion.data.lineEnd) : null,
  ]);
  const body = h("div", { class:"code-panel-body" });
  if (expansion.status === "loading"){
    body.appendChild(h("div", { class:"code-msg loading" }, [h("span", { class:"spin" }, "\u27f3"), "Decompressing range..."]));
  } else if (expansion.status === "error"){
    body.appendChild(h("div", { class:"code-msg error" }, ["\u26a0 ", expansion.message]));
  } else if (expansion.status === "loaded"){
    expansion.data.lines.forEach((l) => {
      body.appendChild(h("div", { class:"code-line" }, [ h("span", { class:"n" }, String(l.n)), h("span", { class:"t" }, l.text || "\u00a0") ]));
    });
  }
  return h("div", { class:"code-panel" }, [head, body]);
}

function ambientGlow(){ return h("div", { class:"ambient" }, [ h("div", { class:"glow" }), h("div", { class:"grid" }) ]); }

function renderIntake(){
  const isLoading = state.phase === "loading";
  const isError = state.phase === "error";
  const input = h("input", {
    class:"intake-input", placeholder:"Paste public GitHub repository URL", autofocus:"true",
    oninput: (e) => { state.draftUrl = e.target.value; },
  });
  input.value = state.draftUrl || "";
  if (isLoading) input.setAttribute("disabled","true");

  const form = h("form", { class:"intake-form", onsubmit: (e) => { e.preventDefault(); if (!input.value.trim() || isLoading) return; submitRepoUrl(input.value); } }, [
    h("div", { class:"intake-bar" + (isLoading ? " intake-bar--loading" : "") }, [
      h("span", { class:"prompt-caret mono" }, "\u003e"),
      input,
      h("button", { class:"btn-primary", type:"submit", disabled: isLoading || undefined }, ["Initialize Brain \u2192"]),
    ]),
  ]);

  const status = h("div", { class:"status-area", id:"status-area" }, [ isLoading ? renderTicker() : (isError ? h("div", { class:"error-text" }, ["\u26a0 ", state.errorMessage]) : null) ]);

  return h("div", { class:"intake-screen" }, [
    ambientGlow(),
    h("div", { class:"intake-inner" }, [
      h("div", { class:"eyebrow" }, [ h("span", { class:"dot" }), "FSL Repository Intelligence" ]),
      h("h1", { class:"title mono" }, "Repository Gateway"),
      h("p", { class:"subtitle" }, "Paste a public repository. We give it spatial awareness in seconds."),
      form, status,
    ]),
  ]);
}

function renderTicker(){
  const step = TICKER_STEPS[state.tickerIndex % TICKER_STEPS.length];
  return h("div", { class:"ticker mono" }, [ h("span", { style:"color:#22d3ee;" }, "\u25b8"), step ]);
}
function renderTickerOnly(){
  const area = document.getElementById("status-area");
  if (!area) return;
  area.innerHTML = "";
  if (state.phase === "loading") area.appendChild(renderTicker());
}

function renderWorkspace(){
  const root = h("div", { class:"workspace" });
  root.appendChild(h("header", { class:"ws-header" }, [
    h("div", { class:"ws-header-left" }, [
      h("span", { class:"dot" }),
      h("span", { class:"repo-name mono" }, state.manifest.header.repoKey),
      h("span", { class:"branch-pill mono" }, state.manifest.header.branch),
    ]),
    h("div", { class:"ws-header-right" }, [
      h("span", { class:"ws-stats mono" }, state.manifest.header.ratio + "x compressed \u2014 " + state.manifest.header.files + " files"),
      h("button", { class:"icon-btn", onclick: () => { state.hudOpen = !state.hudOpen; render(); } }, "Structure"),
      h("button", { class:"icon-btn", onclick: resetWorkspace }, "\u21bb New repo"),
    ]),
  ]));

  const panels = h("div", { class:"ws-panels" });
  panels.appendChild(renderChatPanel());
  const hud = renderHudPanel();
  if (state.hudOpen) hud.classList.add("hud-panel--open");
  panels.appendChild(hud);
  const scrim = h("div", { class:"hud-scrim" + (state.hudOpen ? " hud-scrim--open" : ""), onclick: () => { state.hudOpen = false; render(); } });
  panels.appendChild(scrim);
  root.appendChild(panels);
  return root;
}

function renderChatPanel(){
  const scroll = h("div", { class:"chat-scroll", id:"chat-scroll" });
  state.messages.forEach((m) => {
    scroll.appendChild(h("div", { class:"bubble-row bubble-row--" + m.role }, [
      h("div", { class:"bubble bubble--" + m.role }, renderMessageContent(m.content, m.id)),
    ]));
  });
  if (state.isTyping){
    scroll.appendChild(h("div", { class:"bubble-row bubble-row--assistant" }, [
      h("div", { class:"bubble bubble--assistant typing" }, [ h("span"), h("span"), h("span") ]),
    ]));
  }

  const draft = h("input", { class:"chat-input", placeholder:"Ask about the codebase...", oninput: (e) => { state.draftMsg = e.target.value; } });
  draft.value = state.draftMsg || "";
  const sendBtn = h("button", { class:"send-btn", type:"submit" }, "\u27a4");
  if (!draft.value.trim()) sendBtn.setAttribute("disabled","true");
  draft.addEventListener("input", () => { sendBtn.disabled = !draft.value.trim(); });

  const form = h("form", { class:"chat-input-row", onsubmit: (e) => { e.preventDefault(); if (!draft.value.trim()) return; const v = draft.value; sendMessage(v); } }, [
    h("div", { class:"chat-input-bar" }, [ h("span", { class:"prompt-caret mono" }, "\u003e"), draft, sendBtn ]),
  ]);

  const panel = h("section", { class:"chat-panel" }, [scroll, form]);
  requestAnimationFrame(() => { scroll.scrollTop = scroll.scrollHeight; });
  return panel;
}

function renderHudPanel(){
  const tabs = h("div", { class:"hud-tabs" }, [
    h("button", { class:"hud-tab" + (state.rightTab==="tree" ? " hud-tab--active" : ""), onclick: () => { state.rightTab="tree"; render(); } }, "Topological Tree"),
    h("button", { class:"hud-tab" + (state.rightTab==="signals" ? " hud-tab--active" : ""), onclick: () => { state.rightTab="signals"; render(); } }, "Signal Vectors"),
  ]);
  const body = h("div", { class:"hud-body" }, state.rightTab === "tree" ? renderTree() : renderSignals());
  return h("section", { class:"hud-panel" }, [tabs, body]);
}

function isLeafNode(node){ return node && typeof node.chunk_id === "string"; }

function renderTreeNode(node, name, depth){
  const wrap = h("div", {});
  let open = depth < 1;
  const entries = Object.keys(node).filter((k) => k[0] !== "_");
  const childWrap = h("div", { style: open ? "" : "display:none;" });

  const row = h("button", { class:"tree-row", style:"padding-left:" + (depth*14+4) + "px;", onclick: () => { open = !open; childWrap.style.display = open ? "" : "none"; arrow.textContent = open ? "\u25be" : "\u25b8"; } }, []);
  const arrow = h("span", {}, open ? "\u25be" : "\u25b8");
  row.appendChild(arrow);
  row.appendChild(h("span", { class:"grow" }, "\ud83d\udcc1 " + name));
  row.appendChild(h("span", { class:"meta" }, (node._count||0) + " files"));
  wrap.appendChild(row);

  entries.forEach((key) => {
    const child = node[key];
    if (isLeafNode(child)){
      const fileRow = h("button", { class:"tree-row", style:"padding-left:" + ((depth+1)*14+18) + "px;", onclick: () => toggleChunkExpansion("tree:"+key, child.chunk_id) }, [
        h("span", { class:"grow" }, "\ud83d\udcc4 " + key),
        h("span", { class:"meta" }, fmtBytes(child.bytes)),
      ]);
      childWrap.appendChild(fileRow);
      const expansion = state.expanded["tree:"+key];
      if (expansion) childWrap.appendChild(renderExpandedPanel(expansion, key));
    } else {
      childWrap.appendChild(renderTreeNode(child, key, depth+1));
    }
  });
  wrap.appendChild(childWrap);
  return wrap;
}

function renderTree(){
  if (!state.listChunks || !state.listChunks.tree) return h("div", { class:"hud-empty" }, "No tree data loaded yet.");
  return [renderTreeNode(state.listChunks.tree, state.listChunks.repo, 0)];
}

function renderSignals(){
  const fv = state.featureVector;
  if (!fv) return h("div", { class:"hud-empty" }, "No signal vector loaded yet.");
  const maxScore = Math.max.apply(null, fv.detected_signals.map((s) => s.score).concat([1]));

  const stack = h("div", {}, [
    h("p", { class:"section-label" }, "Heuristic Signal Stack"),
    ...fv.detected_signals.map((s) => h("div", { class:"signal-card" }, [
      h("div", { class:"signal-card-top" }, [
        h("span", { class:"signal-label mono" }, s.label),
        h("span", { class:"domain-pill domain-" + s.domain + " mono" }, s.domain),
      ]),
      h("div", { class:"signal-bar" }, [ h("div", { class:"signal-bar-fill", style:"width:" + Math.max(8, (s.score/maxScore)*100) + "%;" }) ]),
    ])),
  ]);

  const cloud = h("div", { style:"margin-top:20px;" }, [
    h("p", { class:"section-label" }, "Top 15 Density Keywords"),
    h("div", { class:"kw-cloud" }, fv.top_keywords.map((k) => h("span", { class:"kw-pill mono" }, [k.term, " ", h("b", {}, String(k.count))]))),
  ]);

  const stats = h("div", { style:"margin-top:20px;" }, [
    h("p", { class:"section-label" }, "Footprint"),
    h("div", { class:"stat-grid" }, [
      h("div", { class:"stat-box" }, [ h("div", { class:"l" }, "Files"), h("div", { class:"v" }, String(fv.file_count)) ]),
      h("div", { class:"stat-box" }, [ h("div", { class:"l" }, "Ratio"), h("div", { class:"v" }, fv.compression_ratio + "x") ]),
      h("div", { class:"stat-box" }, [ h("div", { class:"l" }, "Raw"), h("div", { class:"v" }, fmtBytes(fv.raw_bytes)) ]),
      h("div", { class:"stat-box" }, [ h("div", { class:"l" }, "Manifest"), h("div", { class:"v" }, fmtBytes(fv.compressed_bytes)) ]),
    ]),
  ]);

  return [stack, cloud, stats];
}

function resetWorkspace(){
  Object.assign(state, { phase:"intake", repo:null, manifest:null, messages:[], isTyping:false, errorMessage:null, tickerIndex:0, listChunks:null, featureVector:null, rightTab:"tree", expanded:{}, hudOpen:false, draftUrl:"", draftMsg:"" });
  render();
}

function render(){
  const root = document.getElementById("root");
  root.innerHTML = "";
  root.appendChild(state.phase === "workspace" ? renderWorkspace() : renderIntake());
}

render();
`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }
    if (url.pathname === "/health") {
      return json({ status: "ok", version: VERSION });
    }
    if (url.pathname === "/api/chat" && request.method === "POST") {
      return handleChat(request, env);
    }
    if (url.pathname === "/" || url.pathname === "") {
      return new Response(pageHtml(), { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }
    return new Response("Not found", { status: 404, headers: CORS });
  },
};
