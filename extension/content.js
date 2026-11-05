(() => {
  if (window.top !== window) return;
  if (window.__geminiPanelLoaded) return; // guard against double injection
  window.__geminiPanelLoaded = true;

  const api = globalThis.browser ?? chrome;
  const MAX_CHARS = 30000;
  const PANEL_W = 380;
  const SUGGESTIONS = ["Summarize this page", "List the key points", "Explain it simply"];
  const MODES = [["page", "Page"], ["selection", "Selection"], ["none", "None"]];
  const PLACEHOLDERS = { page: "Ask about this page", selection: "Ask about the selection", none: "Ask anything" };

  const svg = (d) => '<svg viewBox="0 0 16 16">' + d + "</svg>";
  const ICON_COPY = svg('<rect x="5.5" y="5.5" width="8" height="8" rx="1.8"/><path d="M10.5 5.5V4A1.8 1.8 0 0 0 8.7 2.2H4A1.8 1.8 0 0 0 2.2 4v4.7A1.8 1.8 0 0 0 4 10.5h1.5"/>');
  const ICON_CHECK = svg('<path d="M3 8.5l3.2 3.2L13 4.8"/>');
  const ICON_REGEN = svg('<path d="M13.3 8A5.3 5.3 0 1 1 11.7 4.2"/><path d="M13.5 2.5v3h-3"/>');

  let history = [];   // {role: "user" | "model", text}
  let host = null;
  let busy = false;
  let mode = "page";
  let lastSel = "";   // last non-empty page selection (survives focus moving into the panel)
  let copying = false;
  let current = null; // running request: { stop() }
  let onSelChange = null;
  let pushOn = true;     // push the page aside instead of covering it
  let pushSaved = null;  // the page's own inline margin-right, restored on close

  function applyPush(on) {
    const h = document.documentElement;
    if (on) {
      if (!pushSaved) {
        pushSaved = { v: h.style.getPropertyValue("margin-right"), p: h.style.getPropertyPriority("margin-right") };
      }
      h.style.setProperty("margin-right", PANEL_W + "px", "important");
    } else if (pushSaved) {
      if (pushSaved.v) h.style.setProperty("margin-right", pushSaved.v, pushSaved.p);
      else h.style.removeProperty("margin-right");
      pushSaved = null;
    }
  }

  // Per-tab state (chat, context mode, panel open) lives in the background script, keyed by tab id
  const MAX_SAVED = 40;
  let ready = null;
  function saveState() {
    const state = { open: !!host, mode, history: history.slice(-MAX_SAVED) };
    try { api.runtime.sendMessage({ type: "tab-state-set", state }).catch(() => {}); } catch (e) {}
  }
  const validEntry = (h) => h && (h.role === "user" || h.role === "model") && typeof h.text === "string";

  function esc(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function inline(s) {
    return s.split(/(`[^`]+`)/).map((part) => {
      if (part.length > 2 && part[0] === "`" && part.endsWith("`")) return "<code>" + esc(part.slice(1, -1)) + "</code>";
      let t = esc(part);
      t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
      t = t.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
      t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
      return t;
    }).join("");
  }
  function mdToHtml(src) {
    const lines = src.replace(/\r/g, "").split("\n");
    let out = "", list = null, inCode = false, code = [];
    const closeList = () => { if (list) { out += "</" + list + ">"; list = null; } };
    const openList = (t) => { if (list !== t) { closeList(); out += "<" + t + ">"; list = t; } };
    for (const line of lines) {
      if (line.trim().startsWith("```")) {
        if (inCode) { out += "<pre><code>" + esc(code.join("\n")) + "</code></pre>"; code = []; inCode = false; }
        else { closeList(); inCode = true; }
        continue;
      }
      if (inCode) { code.push(line); continue; }
      let m;
      if ((m = line.match(/^\s*[*-]\s+(.*)/))) { openList("ul"); out += "<li>" + inline(m[1]) + "</li>"; }
      else if ((m = line.match(/^\s*\d+[.)]\s+(.*)/))) { openList("ol"); out += "<li>" + inline(m[1]) + "</li>"; }
      else if ((m = line.match(/^#{1,6}\s+(.*)/))) { closeList(); out += "<h4>" + inline(m[1]) + "</h4>"; }
      else if (!line.trim()) { closeList(); }
      else { closeList(); out += "<p>" + inline(line) + "</p>"; }
    }
    if (inCode) out += "<pre><code>" + esc(code.join("\n")) + "</code></pre>";
    closeList();
    return out;
  }
  function renderMd(el, text) {
    const doc = new DOMParser().parseFromString(mdToHtml(text), "text/html");
    el.replaceChildren(...doc.body.childNodes);
  }

  const el = (tag, cls) => { const n = document.createElement(tag); if (cls) n.className = cls; return n; };

  async function copyText(t) {
    try { await navigator.clipboard.writeText(t); return true; } catch (e) {}
    try {
      copying = true; // do not treat our temporary textarea as a user selection
      const ta = document.createElement("textarea");
      ta.value = t;
      ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch (e) {
      return false;
    } finally {
      setTimeout(() => { copying = false; }, 50);
    }
  }

  document.addEventListener("selectionchange", () => {
    if (copying) return;
    const s = String(window.getSelection() || "").trim();
    if (s) lastSel = s.slice(0, 5000);
    else if (!host || document.activeElement !== host) lastSel = "";
    if (onSelChange) onSelChange();
  });

  api.runtime.onMessage.addListener((msg) => {
    if (msg.type === "toggle") (ready || Promise.resolve()).then(toggle);
  });

  function toggle() {
    if (host) {
      if (current) current.stop();
      onSelChange = null;
      applyPush(false);
      host.remove();
      host = null;
      saveState();
      return;
    }
    build();
    saveState();
  }

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    [hidden] { display: none !important; }
    .p {
      --bg: rgba(246,246,248,.84); --fg: #1d1d1f; --mut: #6e6e73; --line: rgba(0,0,0,.12);
      --hover: rgba(0,0,0,.07); --field: rgba(255,255,255,.85); --code: rgba(0,0,0,.07); --on: #fff;
      --err-bg: rgba(255,59,48,.12); --err-fg: #c4271c; --acc: #007aff; --link: #0066cc;
      height: 100%; display: flex; flex-direction: column;
      background: var(--bg); color: var(--fg);
      -webkit-backdrop-filter: blur(30px) saturate(180%); backdrop-filter: blur(30px) saturate(180%);
      border-left: 1px solid var(--line);
      font: 13px/1.45 -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif;
      animation: in .18s ease-out;
    }
    @media (prefers-color-scheme: dark) {
      .p { --bg: rgba(30,30,32,.84); --fg: #f5f5f7; --mut: #98989d; --line: rgba(255,255,255,.14);
           --hover: rgba(255,255,255,.1); --field: rgba(255,255,255,.08); --code: rgba(255,255,255,.1); --on: rgba(255,255,255,.18);
           --err-bg: rgba(255,69,58,.18); --err-fg: #ff8a80; --acc: #0a84ff; --link: #64b5ff; }
    }
    @keyframes in { from { transform: translateX(24px); opacity: 0; } to { transform: none; opacity: 1; } }
    button { font: inherit; }
    .top { display: flex; align-items: center; justify-content: space-between; padding: 10px 12px 10px 16px; border-bottom: 1px solid var(--line); }
    .title { font-weight: 600; font-size: 14px; }
    .tools { display: flex; gap: 2px; }
    .ic { width: 28px; height: 28px; border: none; border-radius: 7px; background: none; color: var(--mut); cursor: pointer;
          display: flex; align-items: center; justify-content: center; }
    .ic:hover { background: var(--hover); color: var(--fg); }
    .ic svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.4; stroke-linecap: round; stroke-linejoin: round; }
    .set { padding: 12px 16px; border-bottom: 1px solid var(--line); display: flex; flex-direction: column; gap: 8px; }
    .set label { font-weight: 600; }
    .row { display: flex; gap: 8px; }
    .row input { flex: 1; min-width: 0; height: 28px; border-radius: 7px; border: 1px solid var(--line); background: var(--field);
                 color: var(--fg); padding: 0 8px; font: inherit; outline: none; }
    .row input:focus { border-color: var(--acc); }
    .pill { height: 28px; padding: 0 14px; border: none; border-radius: 7px; background: var(--acc); color: #fff; font-weight: 500; cursor: pointer; }
    .hint { color: var(--mut); font-size: 12px; }
    .set label.chk { display: flex; align-items: center; gap: 8px; font-weight: 400; cursor: pointer; }
    a { color: var(--link); }
    .msgs { flex: 1; overflow-y: auto; padding: 14px 16px; display: flex; flex-direction: column; gap: 12px; }
    .empty { margin: auto; text-align: center; display: flex; flex-direction: column; gap: 14px; align-items: center; }
    .big { font-size: 17px; font-weight: 600; }
    .chips { display: flex; flex-direction: column; gap: 6px; }
    .chip { border: 1px solid var(--line); background: var(--field); color: var(--fg); border-radius: 14px; padding: 6px 14px; cursor: pointer; }
    .chip:hover { background: var(--hover); }
    .msg { word-wrap: break-word; overflow-wrap: anywhere; }
    .u { align-self: flex-end; max-width: 88%; background: var(--acc); color: #fff; padding: 7px 12px; border-radius: 16px; white-space: pre-wrap; }
    .body p { margin: 0 0 8px; } .body ul, .body ol { margin: 0 0 8px; padding-left: 20px; } .body li { margin: 2px 0; }
    .body h4 { margin: 10px 0 4px; font-size: 14px; }
    .body code { background: var(--code); padding: 1px 5px; border-radius: 4px; font: 12px ui-monospace, Menlo, monospace; }
    .body pre { background: var(--code); padding: 8px 10px; border-radius: 8px; overflow-x: auto; margin: 0 0 8px; }
    .body pre code { padding: 0; background: none; }
    .body > :last-child { margin-bottom: 0; }
    .acts { display: flex; gap: 2px; margin: 4px 0 0 -6px; }
    .acts .ic { width: 24px; height: 24px; }
    .acts .ic svg { width: 14px; height: 14px; }
    .note { color: var(--mut); font-size: 12px; margin-top: 6px; }
    .e { background: var(--err-bg); color: var(--err-fg); padding: 8px 12px; border-radius: 12px; white-space: pre-wrap; font-size: 12px; }
    .retry { display: block; margin-top: 8px; border: 1px solid currentColor; background: none; color: inherit; border-radius: 12px; padding: 2px 12px; cursor: pointer; font-size: 12px; }
    .dots i { display: inline-block; width: 6px; height: 6px; margin-right: 4px; border-radius: 50%; background: var(--mut); animation: b 1.2s infinite; }
    .dots i:nth-child(2) { animation-delay: .15s; } .dots i:nth-child(3) { animation-delay: .3s; }
    @keyframes b { 0%, 60%, 100% { opacity: .25; } 30% { opacity: 1; } }
    .bar { padding: 8px 12px 12px; }
    .seg { display: flex; background: var(--hover); border-radius: 8px; padding: 2px; }
    .seg button { flex: 1; border: none; background: none; color: var(--mut); font-size: 12px; padding: 3px 10px; border-radius: 6px; cursor: pointer; }
    .seg button.on { background: var(--on); color: var(--fg); box-shadow: 0 1px 2px rgba(0,0,0,.2); }
    .ctxinfo { color: var(--mut); font-size: 11px; margin: 4px 4px 8px; min-height: 14px; }
    .field { display: flex; align-items: flex-end; gap: 6px; border: 1px solid var(--line); background: var(--field); border-radius: 18px; padding: 5px 5px 5px 14px; }
    .field:focus-within { border-color: var(--acc); }
    textarea { flex: 1; border: none; outline: none; resize: none; background: none; color: var(--fg); font: inherit; max-height: 120px; padding: 4px 0; }
    textarea::placeholder { color: var(--mut); }
    .send { width: 26px; height: 26px; border: none; border-radius: 50%; background: var(--acc); color: #fff; cursor: pointer; flex: none;
            display: flex; align-items: center; justify-content: center; }
    .send:disabled { opacity: .3; cursor: default; }
    .send svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.9; stroke-linecap: round; stroke-linejoin: round; }
    .send .stop-sq { fill: currentColor; stroke: none; }
  `;

  const HTML = `
    <div class="p">
      <div class="top">
        <span class="title">Gemini-3.5-flash</span>
        <span class="tools">
          <button class="ic" id="new" title="New chat" aria-label="New chat"><svg viewBox="0 0 16 16"><path d="M9 2.5H4.5A1.5 1.5 0 0 0 3 4v7.5A1.5 1.5 0 0 0 4.5 13H12a1.5 1.5 0 0 0 1.5-1.5V7M11.5 2l2.5 2.5L8 10.5 5.5 11l.5-2.5z"/></svg></button>
          <button class="ic" id="cfg" title="Settings" aria-label="Settings"><svg viewBox="0 0 16 16"><path d="M2.5 5h11M2.5 11h11"/><circle cx="6" cy="5" r="1.7"/><circle cx="10" cy="11" r="1.7"/></svg></button>
          <button class="ic" id="x" title="Close" aria-label="Close"><svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8"/></svg></button>
        </span>
      </div>
      <div class="set" id="set" hidden>
        <label for="k">Gemini API key</label>
        <div class="row"><input id="k" type="password" placeholder="AIza..." autocomplete="off" spellcheck="false"><button class="pill" id="save">Save</button></div>
        <label class="chk"><input type="checkbox" id="push"> Push the page aside instead of covering it</label>
        <div class="hint"><span id="st">Stored locally in the extension.</span> <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer">Get a key</a></div>
      </div>
      <div class="msgs" id="m">
        <div class="empty" id="empty"><div class="big">Ask about this page</div><div class="chips" id="chips"></div></div>
      </div>
      <div class="bar">
        <div class="seg" id="seg"></div>
        <div class="ctxinfo" id="ci"></div>
        <div class="field">
          <textarea id="t" rows="1" placeholder="Ask about this page"></textarea>
          <button class="send" id="s" disabled aria-label="Send">
            <svg id="ic-send" viewBox="0 0 16 16"><path d="M8 13V3M3.5 7.5L8 3l4.5 4.5"/></svg>
            <svg id="ic-stop" viewBox="0 0 16 16" hidden><rect class="stop-sq" x="4" y="4" width="8" height="8" rx="1.5"/></svg>
          </button>
        </div>
      </div>
    </div>`;

  function build() {
    if (host) return;
    host = document.createElement("div");
    host.style.cssText = "all:initial;position:fixed;top:0;right:0;height:100vh;width:" + PANEL_W + "px;z-index:2147483647;";
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = "<style>" + CSS + "</style>" + HTML;
    document.documentElement.appendChild(host);
    applyPush(pushOn);

    const $ = (id) => root.getElementById(id);
    const box = $("m"), input = $("t"), sendBtn = $("s"), empty = $("empty"), seg = $("seg"), info = $("ci");

    // Buttons must not steal focus or clear the page selection
    root.addEventListener("mousedown", (e) => {
      if (e.target && e.target.closest && e.target.closest("button")) e.preventDefault();
    });

    const curSel = () => (String(window.getSelection() || "").trim() || lastSel).slice(0, 5000);
    const nearBottom = () => box.scrollHeight - box.scrollTop - box.clientHeight < 80;

    function updateInfo() {
      const n = curSel().length;
      info.textContent =
        mode === "page" ? (n ? "Reads this page and your selection (" + n + " chars)" : "Reads the text of this page")
        : mode === "selection" ? (n ? n + " characters selected" : "Select text on the page first")
        : "No page context is sent";
    }
    function setMode(m, save) {
      mode = m;
      seg.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.m === m));
      input.placeholder = PLACEHOLDERS[m];
      updateInfo();
      if (save) saveState();
    }
    MODES.forEach(([id, label]) => {
      const b = el("button"); b.dataset.m = id; b.textContent = label;
      b.onclick = () => setMode(id, true);
      seg.appendChild(b);
    });
    onSelChange = updateInfo;
    setMode(mode, false);

    function addUser(text) {
      empty.hidden = true;
      const d = el("div", "msg u"); d.textContent = text;
      box.appendChild(d); box.scrollTop = box.scrollHeight;
    }
    function addAssistant() {
      empty.hidden = true;
      const d = el("div", "msg a"), body = el("div", "body");
      d.appendChild(body); box.appendChild(d);
      return { d, body };
    }
    function iconBtn(svgHtml, label) {
      const b = el("button", "ic"); b.title = label; b.setAttribute("aria-label", label); b.innerHTML = svgHtml;
      return b;
    }
    function addActions(d, text, withRegen) {
      const row = el("div", "acts");
      const copy = iconBtn(ICON_COPY, "Copy");
      copy.onclick = async () => {
        const ok = await copyText(text);
        if (ok) { copy.innerHTML = ICON_CHECK; setTimeout(() => { copy.innerHTML = ICON_COPY; }, 1200); }
      };
      row.appendChild(copy);
      if (withRegen) {
        const rg = iconBtn(ICON_REGEN, "Regenerate"); rg.classList.add("regen");
        rg.onclick = regenerate;
        row.appendChild(rg);
      }
      d.appendChild(row);
    }

    function syncSend() {
      $("ic-send").hidden = busy;
      $("ic-stop").hidden = !busy;
      sendBtn.disabled = busy ? false : !input.value.trim();
      sendBtn.setAttribute("aria-label", busy ? "Stop" : "Send");
    }
    const fit = () => {
      input.style.height = "auto";
      input.style.height = Math.min(input.scrollHeight, 120) + "px";
      syncSend();
    };

    function fail(b, msg) {
      busy = false; current = null; syncSend();
      b.d.className = "msg e";
      b.d.textContent = msg;
      const r = el("button", "retry"); r.textContent = "Retry";
      r.onclick = () => { b.d.remove(); run(); };
      b.d.appendChild(r);
      if (/api key/i.test(msg)) $("set").hidden = false;
      box.scrollTop = box.scrollHeight;
    }

    function run() {
      busy = true; syncSend();
      saveState();
      box.querySelectorAll(".regen").forEach((n) => n.remove());
      const b = addAssistant();
      b.body.innerHTML = '<span class="dots"><i></i><i></i><i></i></span>';
      box.scrollTop = box.scrollHeight;

      const selection = curSel();
      const ctx = { mode, title: document.title, url: location.href };
      if (mode === "page") { ctx.pageText = document.body.innerText.slice(0, MAX_CHARS); ctx.selection = selection; }
      else if (mode === "selection") {
        if (!selection) { fail(b, "Select some text on the page first, then press Retry."); return; }
        ctx.selection = selection;
      }

      let text = "", finished = false, raf = 0;
      let port;
      try { port = api.runtime.connect({ name: "gemini" }); }
      catch (e) { fail(b, "Cannot reach the extension: " + (e.message || e)); return; }

      const paint = () => {
        raf = 0;
        const near = nearBottom();
        renderMd(b.body, text);
        if (near) box.scrollTop = box.scrollHeight;
      };
      function end(errMsg, stopped) {
        if (finished) return;
        finished = true;
        if (raf) cancelAnimationFrame(raf);
        try { port.disconnect(); } catch (e) {}
        if (!text) { fail(b, errMsg || (stopped ? "Stopped." : "Empty response.")); return; }
        busy = false; current = null;
        renderMd(b.body, text);
        history.push({ role: "model", text });
        saveState();
        if (errMsg) { const n = el("div", "note"); n.textContent = "Response interrupted: " + errMsg; b.d.appendChild(n); }
        addActions(b.d, text, true);
        syncSend();
        box.scrollTop = box.scrollHeight;
      }

      current = { stop: () => end("", true) };
      port.onMessage.addListener((m) => {
        if (m.type === "chunk") { text += m.text; if (!raf) raf = requestAnimationFrame(paint); }
        else if (m.type === "done") end("");
        else if (m.type === "error") end(m.error || "Unknown error");
      });
      port.onDisconnect.addListener(() => end("Connection to the extension was lost."));
      port.postMessage({ type: "ask", history: history.slice(), context: ctx });
    }

    function send(textArg) {
      const q = (textArg ?? input.value).trim();
      if (!q || busy) return;
      // drop a question left unanswered by a failed request
      if (history.length && history[history.length - 1].role === "user") history.pop();
      input.value = ""; fit();
      addUser(q);
      history.push({ role: "user", text: q });
      run();
    }

    function regenerate() {
      if (busy) return;
      const last = history[history.length - 1];
      if (!last || last.role !== "model") return;
      history.pop();
      const bubbles = box.querySelectorAll(".msg.a");
      if (bubbles.length) bubbles[bubbles.length - 1].remove();
      run();
    }

    SUGGESTIONS.forEach((s) => {
      const b = el("button", "chip"); b.textContent = s;
      b.onclick = () => send(s);
      $("chips").appendChild(b);
    });

    history.forEach((h, i) => {
      if (h.role === "user") addUser(h.text);
      else {
        const b = addAssistant();
        renderMd(b.body, h.text);
        addActions(b.d, h.text, i === history.length - 1);
      }
    });
    if (history.length && history[history.length - 1].role === "user") {
      fail(addAssistant(), "No answer was received for the last question.");
    }

    sendBtn.onclick = () => { if (busy) { if (current) current.stop(); } else send(); };
    input.addEventListener("input", fit);
    ["keydown", "keyup", "keypress"].forEach((ev) =>
      input.addEventListener(ev, (e) => {
        e.stopPropagation(); // keep site hotkeys (YouTube etc.) out of the input
        if (ev === "keydown" && e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
      })
    );
    $("x").onclick = toggle;
    $("new").onclick = () => {
      if (current) current.stop();
      history = [];
      box.querySelectorAll(".msg").forEach((n) => n.remove());
      empty.hidden = false;
      saveState();
    };
    const pushBox = $("push");
    pushBox.checked = pushOn;
    pushBox.onchange = () => {
      pushOn = pushBox.checked;
      applyPush(pushOn);
      try { api.storage.local.set({ pushPage: pushOn }); } catch (e) {}
    };
    $("cfg").onclick = () => { $("set").hidden = !$("set").hidden; if (!$("set").hidden) $("k").focus(); };
    $("save").onclick = async () => {
      const k = $("k").value.trim();
      if (!k) return;
      await api.storage.local.set({ apiKey: k });
      $("k").value = "";
      $("st").textContent = "Saved.";
      setTimeout(() => { if (host) $("set").hidden = true; }, 700);
    };
    ["keydown", "keyup", "keypress"].forEach((ev) => $("k").addEventListener(ev, (e) => e.stopPropagation()));

    api.storage.local.get("apiKey").then(({ apiKey }) => {
      if (!apiKey) $("set").hidden = false;
    }).catch(() => {});
    syncSend();
    input.focus();
  }

  async function init() {
    let saved = null;
    try {
      const r = await api.runtime.sendMessage({ type: "tab-state-get" });
      saved = r && r.state;
    } catch (e) {}
    try {
      const p = await api.storage.local.get("pushPage");
      if (p && p.pushPage === false) pushOn = false;
    } catch (e) {}
    if (saved) {
      if (Array.isArray(saved.history)) history = saved.history.filter(validEntry);
      if (MODES.some((x) => x[0] === saved.mode)) mode = saved.mode;
      if (saved.open && !host) build();
    }
  }
  ready = init();
})();
