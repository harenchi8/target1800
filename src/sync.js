import { getAllProgress, getAllSettings, putProgressMany, setSettingsMany } from "./db.js";

const te = new TextEncoder();

function b64encode(u8) {
  let s = "";
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return btoa(s);
}

function b64decode(b64) {
  const s = atob(b64);
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return u8;
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", te.encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function deriveAesKey(passphrase, saltU8, iterations = 120000) {
  const keyMaterial = await crypto.subtle.importKey("raw", te.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: saltU8, iterations, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

export function isSyncConfigured(settings) {
  return !!(settings?.syncEndpoint && settings?.syncKey);
}

export function sanitizeEndpoint(endpoint) {
  const e = (endpoint || "").trim().replace(/\/+$/, "");
  return e;
}

function filterSyncedSettings(allSettings) {
  const s = { ...(allSettings || {}) };
  // 端末固有（同期設定自体）は同期しない
  delete s.syncEndpoint;
  delete s.syncKey;
  delete s.syncAuto;
  delete s.syncLastAt;
  delete s.syncLastError;
  return s;
}

export async function exportStateForSync() {
  const [progress, settingsAll] = await Promise.all([getAllProgress(), getAllSettings()]);
  const settings = filterSyncedSettings(settingsAll);
  return {
    schema: 1,
    exportedAt: new Date().toISOString(),
    settings,
    progress
  };
}

function progressUpdatedAt(p) {
  const u = p?.updatedAt ? Date.parse(p.updatedAt) : 0;
  const m = p?.meaningLastAt ? Date.parse(p.meaningLastAt) : 0;
  const s = p?.spellingLastAt ? Date.parse(p.spellingLastAt) : 0;
  return Math.max(u || 0, m || 0, s || 0);
}

export async function mergeAndImportState(remoteState) {
  const [localProgress, localSettingsAll] = await Promise.all([getAllProgress(), getAllSettings()]);
  const localSettings = filterSyncedSettings(localSettingsAll);

  const localMap = new Map((localProgress || []).map((p) => [p.wordId, p]));
  const remoteList = remoteState?.progress || [];
  const merged = [];

  for (const rp of remoteList) {
    const lp = localMap.get(rp.wordId);
    if (!lp) {
      merged.push(rp);
      continue;
    }
    const lt = progressUpdatedAt(lp);
    const rt = progressUpdatedAt(rp);
    merged.push(rt >= lt ? rp : lp);
    localMap.delete(rp.wordId);
  }
  for (const rest of localMap.values()) merged.push(rest);

  await putProgressMany(merged);

  // 設定は remote 優先（ただし端末固有は除外済み）
  await setSettingsMany({ ...localSettings, ...(remoteState?.settings || {}) });
}

export async function encryptState(passphrase, stateObj) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveAesKey(passphrase, salt);
  const plaintext = te.encode(JSON.stringify(stateObj));
  const cipherBuf = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
  return {
    v: 1,
    salt: b64encode(salt),
    iv: b64encode(iv),
    data: b64encode(new Uint8Array(cipherBuf))
  };
}

export async function decryptState(passphrase, payload) {
  if (!payload || payload.v !== 1) throw new Error("payloadの形式が不正です");
  const salt = b64decode(payload.salt);
  const iv = b64decode(payload.iv);
  const data = b64decode(payload.data);
  const key = await deriveAesKey(passphrase, salt);
  const plainBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, data);
  return JSON.parse(new TextDecoder().decode(new Uint8Array(plainBuf)));
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json?.error || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return json;
}

export function createSyncManager({ getSettings, setSettingValue, toast }) {
  let timer = null;
  let inflight = false;

  async function pushNow(reason = "manual") {
    const s = getSettings();
    if (!isSyncConfigured(s)) return { skipped: true, reason: "not_configured" };
    const endpoint = sanitizeEndpoint(s.syncEndpoint);
    const key = s.syncKey;

    if (!endpoint) return { skipped: true, reason: "no_endpoint" };
    if (!("crypto" in window) || !crypto.subtle) throw new Error("このブラウザは暗号化に対応していません");

    const keyId = await sha256Hex(key);
    const state = await exportStateForSync();
    const payload = await encryptState(key, state);
    const updatedAt = new Date().toISOString();

    const res = await postJson(`${endpoint}/sync/push`, { keyId, updatedAt, payload, reason });
    await setSettingValue("syncLastAt", updatedAt);
    await setSettingValue("syncLastError", null);
    toast?.("同期しました");
    return res;
  }

  async function pullAndRestore() {
    const s = getSettings();
    if (!isSyncConfigured(s)) return { skipped: true, reason: "not_configured" };
    const endpoint = sanitizeEndpoint(s.syncEndpoint);
    const key = s.syncKey;
    const keyId = await sha256Hex(key);

    const res = await postJson(`${endpoint}/sync/pull`, { keyId });
    if (!res.found) throw new Error("クラウド側にデータがありません");

    const state = await decryptState(key, res.payload);
    await mergeAndImportState(state);
    await setSettingValue("syncLastAt", new Date().toISOString());
    await setSettingValue("syncLastError", null);
    toast?.("復元しました");
    return { ok: true };
  }

  function schedulePush(reason = "auto") {
    const s = getSettings();
    if (!isSyncConfigured(s) || !s.syncAuto) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      timer = null;
      if (inflight) return;
      inflight = true;
      try {
        await pushNow(reason);
      } catch (e) {
        await setSettingValue("syncLastError", e?.message || String(e));
      } finally {
        inflight = false;
      }
    }, 1200);
  }

  return { pushNow, pullAndRestore, schedulePush };
}


