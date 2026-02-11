/**
 * Cloudflare Workers: 合言葉同期API（KV）
 *
 * - クライアントは payload を端末側で暗号化して送信（Workerは復号しない）
 * - keyId = SHA-256(passphrase) をKVキーとして保存（passphrase自体は送らない）
 *
 * バインディング:
 * - SYNC_KV (KV namespace)
 */

const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type"
};

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    status: init.status || 200,
    headers: { "content-type": "application/json; charset=utf-8", ...corsHeaders, ...(init.headers || {}) }
  });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });

    // 疎通確認用（ブラウザで開ける）
    if (req.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, service: "target1800-sync", ts: new Date().toISOString() });
    }

    if (req.method !== "POST") return json({ error: "Method Not Allowed" }, { status: 405 });

    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: "Invalid JSON" }, { status: 400 });
    }

    if (url.pathname === "/sync/push") {
      const { keyId, updatedAt, payload } = body || {};
      if (!keyId || typeof keyId !== "string" || keyId.length < 16) return json({ error: "keyId required" }, { status: 400 });
      if (!updatedAt || typeof updatedAt !== "string") return json({ error: "updatedAt required" }, { status: 400 });
      if (!payload) return json({ error: "payload required" }, { status: 400 });

      const existingRaw = await env.SYNC_KV.get(keyId);
      if (existingRaw) {
        try {
          const ex = JSON.parse(existingRaw);
          const exT = Date.parse(ex.updatedAt || 0) || 0;
          const inT = Date.parse(updatedAt) || 0;
          if (inT && exT && inT < exT) {
            return json({ ok: true, stored: false, ignored: true, updatedAt: ex.updatedAt });
          }
        } catch {
          // ignore parse error, overwrite
        }
      }

      await env.SYNC_KV.put(keyId, JSON.stringify({ updatedAt, payload }));
      return json({ ok: true, stored: true, updatedAt });
    }

    if (url.pathname === "/sync/pull") {
      const { keyId } = body || {};
      if (!keyId || typeof keyId !== "string" || keyId.length < 16) return json({ error: "keyId required" }, { status: 400 });
      const raw = await env.SYNC_KV.get(keyId);
      if (!raw) return json({ found: false });
      try {
        const { updatedAt, payload } = JSON.parse(raw);
        return json({ found: true, updatedAt, payload });
      } catch {
        return json({ error: "Corrupted data" }, { status: 500 });
      }
    }

    return json({ error: "Not Found" }, { status: 404 });
  }
};


