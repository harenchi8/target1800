export function parseHash() {
  const raw = window.location.hash || "#/home";
  const h = raw.startsWith("#") ? raw.slice(1) : raw;
  const [pathPart, queryPart] = h.split("?");
  const path = (pathPart || "/home").replace(/\/+/g, "/");
  const parts = path.split("/").filter(Boolean);
  const query = Object.fromEntries(new URLSearchParams(queryPart || ""));
  return { raw, path: `/${parts.join("/")}`, parts, query };
}

export function onRouteChange(fn) {
  window.addEventListener("hashchange", fn);
}

export function go(hash) {
  window.location.hash = hash;
}


