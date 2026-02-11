export function qs(sel, root = document) {
  return root.querySelector(sel);
}

const SVG_NS = "http://www.w3.org/2000/svg";
const SVG_TAGS = new Set([
  "svg",
  "path",
  "g",
  "circle",
  "rect",
  "line",
  "polyline",
  "polygon",
  "defs",
  "linearGradient",
  "stop",
  "text"
]);

function normalizeAttrName(k) {
  // ariaLabel -> aria-label, ariaHidden -> aria-hidden 等
  if (k.startsWith("aria") && k.length > 4 && /[A-Z]/.test(k[4])) {
    return `aria-${k.slice(4).replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}`.replace("--", "-");
  }
  return k;
}

export function el(tag, props = {}, ...children) {
  const node = SVG_TAGS.has(tag) ? document.createElementNS(SVG_NS, tag) : document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    const nk = normalizeAttrName(k);
    if (nk === "class") node.className = v;
    else if (k === "dataset") Object.assign(node.dataset, v);
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "html") node.innerHTML = v;
    else if (v === false || v === undefined || v === null) continue;
    else node.setAttribute(nk, String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

export function setMain(node) {
  const main = qs("#main");
  main.innerHTML = "";
  main.appendChild(node);
  main.focus?.();
}

let toastTimer = null;
export function toast(message) {
  const t = qs("#toast");
  t.textContent = message;
  t.classList.add("show");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2200);
}

let praiseTimer = null;
let praiseQueue = [];
let praiseShowing = false;

function showNextPraise() {
  const p = qs("#praise");
  if (!p) return;
  const msg = praiseQueue.shift();
  if (!msg) {
    praiseShowing = false;
    return;
  }
  praiseShowing = true;
  p.innerHTML = "";
  p.appendChild(el("div", { class: "praise__text" }, msg));
  p.classList.add("show");
  if (praiseTimer) clearTimeout(praiseTimer);
  praiseTimer = setTimeout(() => {
    p.classList.remove("show");
    setTimeout(showNextPraise, 160);
  }, 2600);
}

export function praise(message) {
  const msg = String(message || "").trim();
  if (!msg) return;
  praiseQueue.push(msg);
  if (!praiseShowing) showNextPraise();
}

export function fmtDateTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("ja-JP", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}


