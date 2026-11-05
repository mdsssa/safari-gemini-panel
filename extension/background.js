const api = globalThis.browser ?? chrome;

// Fallback chain: if a model is overloaded (503) or unavailable, try the next one
const MODELS = ["gemini-3.5-flash", "gemini-3.5-flash-lite", "gemini-flash-lite-latest"];
const BASE = "https://generativelanguage.googleapis.com/v1beta/models/";
const RETRY_STATUSES = [404, 429, 500, 503];

api.action.onClicked.addListener((tab) => {
  api.tabs.sendMessage(tab.id, { type: "toggle" }).catch(() => {});
});

api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== "ask") return;
  askGemini(msg)
    .then(sendResponse)
    .catch((e) => sendResponse({ error: String(e.message || e) }));
  return true;
});

async function askGemini({ history, pageText, selection, title, url }) {
  const { apiKey } = await api.storage.local.get("apiKey");
  if (!apiKey) return { error: "No API key. Click the gear icon in the panel and paste it." };

  const system =
    "You are an assistant in a browser side panel. Reply in the language the user writes in. " +
    "Be concise and to the point. The user is looking at the page below.\n\n" +
    `URL: ${url}\nTitle: ${title}\n` +
    (selection ? `Selected text: ${selection}\n` : "") +
    `\nPage text:\n${pageText}`;

  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: system }] },
    contents: history.map((m) => ({ role: m.role, parts: [{ text: m.text }] })),
  });

  let lastErr = "";
  for (const model of MODELS) {
    try {
      const r = await fetch(`${BASE}${model}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body,
        signal: AbortSignal.timeout(25000),
      });
      if (r.ok) {
        const data = await r.json();
        const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
        return { text: text || "(empty response)" };
      }
      lastErr = `${model}: HTTP ${r.status}`;
      if (RETRY_STATUSES.includes(r.status)) continue;
      return { error: `${lastErr} ${(await r.text()).slice(0, 300)}` };
    } catch (e) {
      lastErr = `${model}: ${e.message || e}`;
    }
  }
  return { error: "All models failed. Last error: " + lastErr };
}
