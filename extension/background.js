const api = globalThis.browser ?? chrome;

// Fallback chain: if a model is overloaded or unavailable, the next one is tried
const MODELS = ["gemini-3.5-flash", "gemini-3.5-flash-lite", "gemini-flash-lite-latest"];
const BASE = "https://generativelanguage.googleapis.com/v1beta/models/";
const RETRY_STATUSES = [404, 429, 500, 503];
const FIRST_BYTE_TIMEOUT_MS = 25000;

class Fatal extends Error {}

// Toolbar click: toggle the panel, injecting the content script first if the page does not have it yet
api.action.onClicked.addListener(async (tab) => {
  try {
    await api.tabs.sendMessage(tab.id, { type: "toggle" });
  } catch (e) {
    try {
      await api.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
      await api.tabs.sendMessage(tab.id, { type: "toggle" });
    } catch (e2) {
      console.error("Gemini Panel: cannot open panel on this page:", e2);
    }
  }
});

// The panel talks to us over a long-lived port so answers can be streamed chunk by chunk
api.runtime.onConnect.addListener((port) => {
  if (port.name !== "gemini") return;
  const ctrl = new AbortController();
  const post = (m) => { try { port.postMessage(m); } catch (e) {} };
  port.onDisconnect.addListener(() => ctrl.abort());
  port.onMessage.addListener((msg) => {
    if (msg.type !== "ask") return;
    streamAnswer(msg, post, ctrl.signal).catch((e) =>
      post({ type: "error", error: String((e && e.message) || e) })
    );
  });
});

function systemPrompt(c) {
  let s =
    "You are an assistant in a browser side panel. Reply in the language the user writes in. " +
    "Be concise and to the point.";
  if (c.mode === "page") {
    s += "\n\nThe user is looking at the page below.\n" +
      `URL: ${c.url}\nTitle: ${c.title}\n` +
      (c.selection ? `Selected text: ${c.selection}\n` : "") +
      `\nPage text:\n${c.pageText || ""}`;
  } else if (c.mode === "selection") {
    s += `\n\nThe user selected this text on the page "${c.title}" (${c.url}):\n${c.selection || ""}`;
  }
  return s;
}

async function streamAnswer({ history, context }, post, outer) {
  const { apiKey } = await api.storage.local.get("apiKey");
  if (!apiKey) {
    return post({ type: "error", error: "No API key. Click the settings icon in the panel and paste it." });
  }

  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: systemPrompt(context || {}) }] },
    contents: history.map((m) => ({ role: m.role, parts: [{ text: m.text }] })),
  });

  let lastErr = "";
  for (const model of MODELS) {
    if (outer.aborted) return;
    const attempt = new AbortController();
    const abortAttempt = () => attempt.abort();
    outer.addEventListener("abort", abortAttempt);
    const timer = setTimeout(() => attempt.abort(), FIRST_BYTE_TIMEOUT_MS);
    let emitted = false;

    const handle = (raw) => {
      const line = raw.trim();
      if (!line.startsWith("data:")) return;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") return;
      let j;
      try { j = JSON.parse(payload); } catch (e) { return; }
      if (j.error) throw new Error(`${j.error.code || ""} ${j.error.message || "stream error"}`.trim());
      if (j.promptFeedback && j.promptFeedback.blockReason && !emitted) {
        throw new Fatal("Blocked by Gemini: " + j.promptFeedback.blockReason);
      }
      const parts = (j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || [];
      const text = parts.filter((p) => !p.thought).map((p) => p.text || "").join("");
      if (text) { emitted = true; post({ type: "chunk", text }); }
    };

    try {
      const r = await fetch(`${BASE}${model}:streamGenerateContent?alt=sse`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body,
        signal: attempt.signal,
      });
      if (!r.ok) {
        lastErr = `${model}: HTTP ${r.status}`;
        if (RETRY_STATUSES.includes(r.status)) continue;
        return post({ type: "error", error: `${lastErr} ${(await r.text()).slice(0, 300)}` });
      }

      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        clearTimeout(timer);
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop();
        for (const l of lines) handle(l);
      }
      buf += dec.decode();
      if (buf.trim()) handle(buf);

      if (outer.aborted) return;
      if (!emitted) { lastErr = `${model}: empty response`; continue; }
      return post({ type: "done" });
    } catch (e) {
      if (outer.aborted) return;
      if (e instanceof Fatal) return post({ type: "error", error: e.message });
      lastErr = `${model}: ${attempt.signal.aborted ? "timeout" : (e && e.message) || e}`;
      if (emitted) return post({ type: "error", error: lastErr });
    } finally {
      clearTimeout(timer);
      outer.removeEventListener("abort", abortAttempt);
    }
  }
  post({ type: "error", error: "All models failed. Last error: " + lastErr });
}
