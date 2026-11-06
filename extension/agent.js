// Page-side toolkit for agent mode: describes the page to the model and performs the actions it asks for.
// It has no UI and no network access; content.js decides what is allowed and when.
(() => {
  if (window.GeminiAgent) return;

  const MAX_ELEMENTS = 120;
  const SNAPSHOT_TEXT = 6000;
  const PAGE_TEXT_MAX = 30000;

  // Actions whose label matches this always need an explicit confirmation, even in "allow for this task" mode
  const SENSITIVE_RE = /(\b(buy|purchase|pay|checkout|check out|order|confirm|delete|remove|unsubscribe|subscribe|transfer|send|submit|sign ?out|log ?out|deactivate|cancel|publish|post|donate|withdraw|apply)\b)|(\u043a\u0443\u043f|\u043e\u043f\u043b\u0430\u0442|\u0437\u0430\u043a\u0430\u0437|\u043e\u0444\u043e\u0440\u043c|\u043f\u043e\u0434\u0442\u0432\u0435\u0440\u0434|\u0443\u0434\u0430\u043b|\u043e\u0442\u043f\u0440\u0430\u0432|\u043f\u0435\u0440\u0435\u0432\u043e\u0434|\u043f\u0435\u0440\u0435\u0432\u0435\u0441\u0442\u0438|\u0432\u044b\u0439\u0442\u0438|\u043f\u043e\u0434\u043f\u0438\u0441|\u043e\u0442\u043c\u0435\u043d|\u043e\u043f\u0443\u0431\u043b\u0438\u043a|\u043f\u043e\u0436\u0435\u0440\u0442\u0432|\u0432\u044b\u0432\u0435\u0441\u0442|\u043f\u043e\u0434\u0430\u0442\u044c)/i;
  // Fields the model must never read or fill
  const PROTECTED_RE = /(pass(word|wd|code)|\bcvv?\b|\bcvc\b|card[\s_-]?(number|no|num)|\biban\b|\bssn\b|social[\s_-]?security|\bpin\b|\botp\b|one[\s_-]?time|\u043f\u0430\u0440\u043e\u043b|\u043d\u043e\u043c\u0435\u0440 \u043a\u0430\u0440\u0442\u044b)/i;

  const SELECTOR = [
    "a[href]", "button", "input:not([type=hidden])", "select", "textarea", "summary",
    "[role=button]", "[role=link]", "[role=checkbox]", "[role=radio]", "[role=switch]", "[role=tab]",
    "[role=menuitem]", "[role=option]", "[role=combobox]", "[role=textbox]", "[role=searchbox]",
    "[contenteditable='']", "[contenteditable=true]", "[onclick]", "[tabindex]:not([tabindex='-1'])",
  ].join(",");
  const TEXT_TYPES = ["", "text", "search", "email", "url", "tel", "number", "date", "time", "datetime-local", "month", "week"];

  let idMap = new Map();

  const clip = (s, n = 80) => {
    s = String(s == null ? "" : s).replace(/\s+/g, " ").trim();
    return s.length > n ? s.slice(0, n - 3) + "..." : s;
  };
  const stripWww = (h) => String(h || "").toLowerCase().replace(/^www\./, "");
  const sameSite = (h) => stripWww(h) === stripWww(location.hostname);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function isVisible(el) {
    const st = getComputedStyle(el);
    if (st.display === "none" || st.visibility === "hidden" || st.opacity === "0") return false;
    if (!el.getClientRects().length) return false;
    const b = el.getBoundingClientRect();
    return b.width > 0 && b.height > 0;
  }

  function isProtected(el) {
    if (!el || !el.tagName) return false;
    const tag = el.tagName.toLowerCase();
    if (tag !== "input" && tag !== "textarea") return false;
    const type = (el.getAttribute("type") || "text").toLowerCase();
    if (type === "password") return true;
    const ac = (el.getAttribute("autocomplete") || "").toLowerCase();
    if (/(^|\s)(cc-[a-z-]+|one-time-code|new-password|current-password)/.test(ac)) return true;
    const hay = [el.getAttribute("name"), el.id, el.getAttribute("aria-label"), el.getAttribute("placeholder")].filter(Boolean).join(" ");
    return PROTECTED_RE.test(hay);
  }

  function kindOf(el) {
    const tag = el.tagName.toLowerCase(), role = el.getAttribute("role"), ce = el.getAttribute("contenteditable");
    if (tag === "a") return "link";
    if (tag === "select") return "select";
    if (tag === "textarea") return "textarea";
    if (tag === "input") {
      const t = (el.getAttribute("type") || "text").toLowerCase();
      if (["button", "submit", "reset", "image"].includes(t)) return "button";
      if (t === "checkbox" || t === "radio") return t;
      return "input(" + t + ")";
    }
    if (tag === "button" || tag === "summary" || role === "button") return "button";
    if (role === "link") return "link";
    if (role === "checkbox" || role === "switch") return "checkbox";
    if (role === "radio") return "radio";
    if (role === "tab" || role === "menuitem" || role === "option") return role;
    if (ce === "" || ce === "true" || ce === "plaintext-only" || role === "textbox" || role === "searchbox" || role === "combobox") return "editable";
    return "clickable";
  }

  function labelOf(el) {
    const aria = el.getAttribute("aria-label");
    if (aria) return clip(aria);
    const lb = el.getAttribute("aria-labelledby");
    if (lb) {
      const t = lb.split(/\s+/).map((id) => { const n = document.getElementById(id); return n ? n.textContent : ""; }).join(" ");
      if (clip(t)) return clip(t);
    }
    if (el.labels && el.labels.length) { const t = clip(el.labels[0].textContent); if (t) return t; }
    const tag = el.tagName.toLowerCase();
    if (tag === "input" && ["submit", "button", "reset"].includes((el.getAttribute("type") || "").toLowerCase())) return clip(el.value);
    const txt = clip(el.innerText || el.textContent);
    if (txt && tag !== "input" && tag !== "textarea" && tag !== "select") return txt;
    const img = el.querySelector && el.querySelector("img[alt]");
    return clip(el.getAttribute("title") || el.getAttribute("placeholder") || el.getAttribute("alt") || (img && img.alt) || el.getAttribute("name") || "");
  }

  function collect() {
    const seen = new Set(), out = [];
    for (const el of document.querySelectorAll(SELECTOR)) {
      if (seen.has(el)) continue;
      seen.add(el);
      if (el.disabled || el.getAttribute("aria-disabled") === "true" || el.closest("[inert]")) continue;
      if (!isVisible(el)) continue;
      const r = el.getBoundingClientRect();
      out.push({ el, inView: r.bottom > 0 && r.top < window.innerHeight && r.right > 0 && r.left < window.innerWidth });
    }
    if (out.length <= MAX_ELEMENTS) return out;
    const inV = out.filter((x) => x.inView), rest = out.filter((x) => !x.inView);
    const keep = new Set(inV.slice(0, MAX_ELEMENTS).concat(rest.slice(0, Math.max(0, MAX_ELEMENTS - inV.length))));
    return out.filter((x) => keep.has(x));
  }

  function describeLine(id, c) {
    const el = c.el, kind = kindOf(el);
    if (isProtected(el)) return `[${id}] ${kind} PROTECTED field - you cannot read or fill it; ask the user to do it themselves`;
    let s = `[${id}] ${kind}`;
    const lab = labelOf(el);
    if (lab) s += ` "${lab}"`;
    if (kind.startsWith("input") || kind === "textarea") { const v = clip(el.value, 60); if (v) s += ` value="${v}"`; }
    if (kind === "select") {
      const opts = [...el.options];
      s += ` selected="${clip(opts[el.selectedIndex] ? opts[el.selectedIndex].text : "", 40)}" options=[${opts.slice(0, 12).map((o) => '"' + clip(o.text, 30) + '"').join(", ")}]`;
    }
    if (kind === "checkbox" || kind === "radio") {
      const checked = typeof el.checked === "boolean" ? el.checked : el.getAttribute("aria-checked") === "true";
      s += checked ? " (checked)" : " (unchecked)";
    }
    if (el.getAttribute("aria-expanded")) s += ` (expanded=${el.getAttribute("aria-expanded")})`;
    if (el.tagName === "A") {
      try {
        const u = new URL(el.href);
        s += ` -> ${u.hostname}${clip(u.pathname + u.search, 60)}`;
        if (!sameSite(u.hostname)) s += " (other site)";
      } catch (e) {}
    }
    if (!c.inView) s += " (offscreen)";
    return s;
  }

  // Numbers are only valid until the next snapshot
  function snapshot() {
    idMap = new Map();
    const lines = collect().map((c, i) => { idMap.set(i + 1, c.el); return describeLine(i + 1, c); });
    const doc = document.documentElement, h = window.innerHeight || 0;
    const body = ((document.body && document.body.innerText) || "").replace(/\n{3,}/g, "\n\n").slice(0, SNAPSHOT_TEXT);
    return `URL: ${location.href}\nTitle: ${document.title}\nScroll: ${Math.round(window.scrollY || 0)}px of ${Math.max(0, doc.scrollHeight - h)}px (viewport ${h}px)\n\n` +
      `Visible page text (truncated):\n${body}\n\nInteractive elements:\n${lines.join("\n") || "(none found)"}`;
  }

  const pageText = () => ((document.body && document.body.innerText) || "").replace(/\n{3,}/g, "\n\n").slice(0, PAGE_TEXT_MAX);

  function formHasProtected(el) {
    const f = el.form || (el.closest && el.closest("form"));
    return !!f && [...f.querySelectorAll("input,textarea")].some(isProtected);
  }
  function isSubmitControl(el) {
    const t = (el.getAttribute("type") || "").toLowerCase();
    return (el.tagName === "BUTTON" && (t === "" || t === "submit")) || (el.tagName === "INPUT" && t === "submit");
  }

  function describe(id) {
    const el = idMap.get(Number(id));
    if (!el) return { error: `There is no element [${id}] in the latest page snapshot.` };
    if (!el.isConnected) return { error: `Element [${id}] is no longer on the page. Look at the page again.` };
    const label = labelOf(el), a = el.closest("a[href]");
    let host = null;
    if (a) { try { host = new URL(a.getAttribute("href"), location.href).hostname; } catch (e) {} }
    return {
      el, kind: kindOf(el), label, protected: isProtected(el),
      linkHost: host && /^https?:$/.test(new URL(a.getAttribute("href"), location.href).protocol) ? host : null,
      sensitive: SENSITIVE_RE.test(label) || (isSubmitControl(el) && formHasProtected(el)),
      formProtected: formHasProtected(el),
    };
  }

  function bringIntoView(el) { if (el.scrollIntoView) el.scrollIntoView({ block: "center", inline: "center" }); }

  function highlight(el, ms) {
    const keep = ["outline", "outline-offset"].map((p) => [p, el.style.getPropertyValue(p), el.style.getPropertyPriority(p)]);
    el.style.setProperty("outline", "3px solid #0a84ff", "important");
    el.style.setProperty("outline-offset", "2px", "important");
    const undo = () => keep.forEach(([p, v, pr]) => { if (v) el.style.setProperty(p, v, pr); else el.style.removeProperty(p); });
    if (ms) setTimeout(undo, ms);
    return undo;
  }

  function click(el) {
    bringIntoView(el);
    const a = el.closest("a[href]");
    if (a && (a.getAttribute("target") || "").toLowerCase() === "_blank") {
      // the agent only follows the current tab
      const t = a.getAttribute("target");
      a.setAttribute("target", "_self");
      setTimeout(() => a.setAttribute("target", t), 1500);
    }
    if (el.focus) el.focus({ preventScroll: true });
    el.click();
  }

  function typeText(el, text, submit) {
    const kind = kindOf(el);
    if (isProtected(el)) return { ok: false, message: "This field is protected. Ask the user to fill it in." };
    const ce = el.getAttribute("contenteditable");
    const editable = ce === "" || ce === "true" || ce === "plaintext-only";
    const textLike = el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && TEXT_TYPES.includes((el.getAttribute("type") || "").toLowerCase()));
    if (!textLike && !editable) return { ok: false, message: `Element is a ${kind}; it cannot be typed into.` };
    bringIntoView(el);
    el.focus && el.focus({ preventScroll: true });
    if (editable) {
      const sel = window.getSelection && window.getSelection();
      if (sel && document.createRange) { const r = document.createRange(); r.selectNodeContents(el); sel.removeAllRanges(); sel.addRange(r); }
      let done = false;
      try { done = !!document.execCommand && document.execCommand("insertText", false, text); } catch (e) {}
      if (!done) { el.textContent = text; el.dispatchEvent(new Event("input", { bubbles: true })); }
    } else {
      // the native setter keeps React/Vue style controlled inputs in sync
      const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, text);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
    if (submit) {
      const opts = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
      const handled = !el.dispatchEvent(new KeyboardEvent("keydown", opts));
      el.dispatchEvent(new KeyboardEvent("keypress", opts));
      el.dispatchEvent(new KeyboardEvent("keyup", opts));
      const form = el.form;
      if (!handled && form && form.requestSubmit) form.requestSubmit();
    }
    return { ok: true };
  }

  function selectOption(el, value) {
    if (el.tagName !== "SELECT") return { ok: false, message: "Element is not a drop-down list." };
    const want = String(value).trim().toLowerCase();
    const opt = [...el.options].find((o) => o.value.toLowerCase() === want) || [...el.options].find((o) => o.text.trim().toLowerCase() === want);
    if (!opt) return { ok: false, message: "No such option. Available: " + [...el.options].slice(0, 20).map((o) => `"${clip(o.text, 30)}"`).join(", ") };
    el.value = opt.value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true };
  }

  function scrollPage(direction) {
    const before = window.scrollY, h = window.innerHeight || 600;
    if (direction === "top") window.scrollTo(0, 0);
    else if (direction === "bottom") window.scrollTo(0, document.documentElement.scrollHeight);
    else window.scrollBy(0, (direction === "up" ? -1 : 1) * Math.round(h * 0.8));
    return window.scrollY !== before;
  }

  function findText(query) {
    const q = String(query || "").toLowerCase();
    if (!q) return { found: false };
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const v = n.nodeValue.toLowerCase(), i = v.indexOf(q);
      if (i < 0 || !n.parentElement || !isVisible(n.parentElement)) continue;
      bringIntoView(n.parentElement);
      return { found: true, context: clip(n.nodeValue.slice(Math.max(0, i - 60), i + q.length + 60), 160) };
    }
    return { found: false };
  }

  window.GeminiAgent = {
    snapshot, describe, pageText, isProtected, click, typeText, selectOption, scrollPage, findText,
    highlight, bringIntoView, sameSite, stripWww, sleep, clip, SENSITIVE_RE,
  };
})();
