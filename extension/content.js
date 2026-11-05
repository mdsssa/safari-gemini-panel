(() => {
  if (window.top !== window) return;
  const api = globalThis.browser ?? chrome;
  const MAX_CHARS = 30000;
  const SUGGESTIONS = ["Summarize this page", "List the key points", "Explain it simply"];
  let history = [];
  let host = null;
  let busy = false;

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

  api.runtime.onMessage.addListener((msg) => {
    if (msg.type === "toggle") toggle();
  });

  function toggle() {
    if (host) { host.remove(); host = null; return; }
    build();
  }

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    [hidden] { display: none !important; }
    .p {
      --bg: rgba(246,246,248,.84); --fg: #1d1d1f; --mut: #6e6e73; --line: rgba(0,0,0,.12);
      --hover: rgba(0,0,0,.07); --field: rgba(255,255,255,.85); --code: rgba(0,0,0,.07);
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
           --hover: rgba(255,255,255,.1); --field: rgba(255,255,255,.08); --code: rgba(255,255,255,.1);
           --err-bg: rgba(255,69,58,.18); --err-fg: #ff8a80; --acc: #0a84ff; --link: #64b5ff; }
    }
    @keyframes in { from { transform: translateX(24px); opacity: 0; } to { transform: none; opacity: 1; } }
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
    .pill { height: 28px; padding: 0 14px; border: none; border-radius: 7px; background: var(--acc); color: #fff; font: inherit; font-weight: 500; cursor: pointer; }
    .hint { color: var(--mut); font-size: 12px; }
    a { color: var(--link); }
    .msgs { flex: 1; overflow-y: auto; padding: 14px 16px; display: flex; flex-direction: column; gap: 12px; }
    .empty { margin: auto; text-align: center; display: flex; flex-direction: column; gap: 14px; align-items: center; }
    .big { font-size: 17px; font-weight: 600; }
    .chips { display: flex; flex-direction: column; gap: 6px; }
    .chip { border: 1px solid var(--line); background: var(--field); color: var(--fg); border-radius: 14px; padding: 6px 14px;
            font: inherit; cursor: pointer; }
    .chip:hover { background: var(--hover); }
    .msg { word-wrap: break-word; overflow-wrap: anywhere; }
    .u { align-self: flex-end; max-width: 88%; background: var(--acc); color: #fff; padding: 7px 12px; border-radius: 16px; white-space: pre-wrap; }
    .a p { margin: 0 0 8px; } .a ul, .a ol { margin: 0 0 8px; padding-left: 20px; } .a li { margin: 2px 0; }
    .a h4 { margin: 10px 0 4px; font-size: 14px; }
    .a code { background: var(--code); padding: 1px 5px; border-radius: 4px; font: 12px ui-monospace, Menlo, monospace; }
    .a pre { background: var(--code); padding: 8px 10px; border-radius: 8px; overflow-x: auto; margin: 0 0 8px; }
    .a pre code { padding: 0; background: none; }
    .a > :last-child { margin-bottom: 0; }
    .e { background: var(--err-bg); color: var(--err-fg); padding: 8px 12px; border-radius: 12px; white-space: pre-wrap; font-size: 12px; }
    .dots i { display: inline-block; width: 6px; height: 6px; margin-right: 4px; border-radius: 50%; background: var(--mut); animation: b 1.2s infinite; }
    .dots i:nth-child(2) { animation-delay: .15s; } .dots i:nth-child(3) { animation-delay: .3s; }
    @keyframes b { 0%, 60%, 100% { opacity: .25; } 30% { opacity: 1; } }
    .bar { padding: 10px 12px 12px; }
    .field { display: flex; align-items: flex-end; gap: 6px; border: 1px solid var(--line); background: var(--field); border-radius: 18px; padding: 5px 5px 5px 14px; }
    .field:focus-within { border-color: var(--acc); }
    textarea { flex: 1; border: none; outline: none; resize: none; background: none; color: var(--fg); font: inherit; max-height: 120px; padding: 4px 0; }
    textarea::placeholder { color: var(--mut); }
    .send { width: 26px; height: 26px; border: none; border-radius: 50%; background: var(--acc); color: #fff; cursor: pointer; flex: none;
            display: flex; align-items: center; justify-content: center; }
    .send:disabled { opacity: .3; cursor: default; }
    .send svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.9; stroke-linecap: round; stroke-linejoin: round; }
  `;

  const HTML = `
    <div class="p">
      <div class="top">
        <span class="title">Gemini</span>
        <span class="tools">
          <button class="ic" id="new" title="New chat" aria-label="New chat"><svg viewBox="0 0 16 16"><path d="M9 2.5H4.5A1.5 1.5 0 0 0 3 4v7.5A1.5 1.5 0 0 0 4.5 13H12a1.5 1.5 0 0 0 1.5-1.5V7M11.5 2l2.5 2.5L8 10.5 5.5 11l.5-2.5z"/></svg></button>
          <button class="ic" id="cfg" title="Settings" aria-label="Settings"><svg viewBox="0 0 16 16"><path d="M2.5 5h11M2.5 11h11"/><circle cx="6" cy="5" r="1.7"/><circle cx="10" cy="11" r="1.7"/></svg></button>
          <button class="ic" id="x" title="Close" aria-label="Close"><svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8"/></svg></button>
        </span>
      </div>
      <div class="set" id="set" hidden>
        <label for="k">Gemini API key</label>
        <div class="row"><input id="k" type="password" placeholder="AIza..." autocomplete="off" spellcheck="false"><button class="pill" id="save">Save</button></div>
        <div class="hint"><span id="st">Stored locally in the extension.</span> <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer">Get a key</a></div>
      </div>
      <div class="msgs" id="m">
        <div class="empty" id="empty"><div class="big">Ask about this page</div><div class="chips" id="chips"></div></div>
      </div>
      <div class="bar"><div class="field">
        <textarea id="t" rows="1" placeholder="Ask about this page"></textarea>
        <button class="send" id="s" disabled aria-label="Send"><svg viewBox="0 0 16 16"><path d="M8 13V3M3.5 7.5L8 3l4.5 4.5"/></svg></button>
      </div></div>
    </div>`;

  function build() {
    host = document.createElement("div");
    host.style.cssText = "all:initial;position:fixed;top:0;right:0;height:100vh;width:380px;z-index:2147483647;";
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = "<style>" + CSS + "</style>" + HTML;
    document.documentElement.appendChild(host);

    const $ = (id) => root.getElementById(id);
    const box = $("m"), input = $("t"), sendBtn = $("s"), empty = $("empty");

    const add = (cls, text) => {
      empty.hidden = true;
      const d = document.createElement("div");
      d.className = "msg " + cls;
      if (cls === "a") renderMd(d, text); else d.textContent = text;
      box.appendChild(d);
      box.scrollTop = box.scrollHeight;
      return d;
    };

    SUGGESTIONS.forEach((s) => {
      const b = document.createElement("button");
      b.className = "chip"; b.textContent = s;
      b.onclick = () => { input.value = s; send(); };
      $("chips").appendChild(b);
    });
    history.forEach((h) => add(h.role === "user" ? "u" : "a", h.text));

    const fit = () => {
      input.style.height = "auto";
      input.style.height = Math.min(input.scrollHeight, 120) + "px";
      sendBtn.disabled = busy || !input.value.trim();
    };

    async function send() {
      const q = input.value.trim();
      if (!q || busy) return;
      busy = true;
      input.value = ""; fit();
      add("u", q);
      history.push({ role: "user", text: q });
      const wait = add("a", "");
      wait.innerHTML = '<span class="dots"><i></i><i></i><i></i></span>';
      let res;
      try {
        res = await api.runtime.sendMessage({
          type: "ask",
          history,
          pageText: document.body.innerText.slice(0, MAX_CHARS),
          selection: String(window.getSelection() || "").slice(0, 5000),
          title: document.title,
          url: location.href,
        });
      } catch (e) {
        res = { error: String(e.message || e) };
      }
      if (res?.error) {
        wait.className = "msg e"; wait.textContent = res.error;
        history.pop();
        if (/api key/i.test(res.error)) $("set").hidden = false;
      } else {
        renderMd(wait, res.text);
        history.push({ role: "model", text: res.text });
      }
      busy = false; fit();
      box.scrollTop = box.scrollHeight;
    }

    sendBtn.onclick = send;
    input.addEventListener("input", fit);
    ["keydown", "keyup", "keypress"].forEach((ev) =>
      input.addEventListener(ev, (e) => {
        e.stopPropagation(); // keep site hotkeys (YouTube etc.) out of the input
        if (ev === "keydown" && e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
      })
    );
    $("x").onclick = toggle;
    $("new").onclick = () => {
      history = [];
      box.querySelectorAll(".msg").forEach((n) => n.remove());
      empty.hidden = false;
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
    input.focus();
  }
})();
