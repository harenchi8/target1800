const DB_BASE = "target1800";
const DB_VERSION = 2;

let activeDbName = DB_BASE;
let dbInstance = null;

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

let dbPromise = null;
export function getActiveDbName() {
  return activeDbName;
}

export function setActiveProfileId(profileId) {
  // 既存データ互換: profileId==="legacy" は従来のDB名を使う
  const nextName = profileId === "legacy" ? DB_BASE : `${DB_BASE}-${profileId}`;
  if (nextName === activeDbName) return;
  activeDbName = nextName;
  try {
    dbInstance?.close?.();
  } catch {
    // ignore
  }
  dbInstance = null;
  dbPromise = null;
}

export function deleteProfileDb(profileId) {
  const name = profileId === "legacy" ? DB_BASE : `${DB_BASE}-${profileId}`;
  return new Promise((resolve, reject) => {
    try {
      const req = indexedDB.deleteDatabase(name);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
      req.onblocked = () => resolve();
    } catch (e) {
      reject(e);
    }
  });
}

export function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(activeDbName, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("progress")) {
        const s = db.createObjectStore("progress", { keyPath: "wordId" });
        s.createIndex("meaningNextReviewAt", "meaningNextReviewAt", { unique: false });
        s.createIndex("spellingNextReviewAt", "spellingNextReviewAt", { unique: false });
      }
      if (!db.objectStoreNames.contains("settings")) {
        db.createObjectStore("settings", { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains("history")) {
        const h = db.createObjectStore("history", { keyPath: "id", autoIncrement: true });
        h.createIndex("ts", "ts", { unique: false });
        h.createIndex("type", "type", { unique: false });
      }
    };
    req.onsuccess = () => {
      dbInstance = req.result;
      resolve(dbInstance);
    };
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

export function createEmptyProgress(wordId) {
  return {
    wordId,
    updatedAt: null,
    meaningCorrect: 0,
    meaningPartial: 0,
    meaningWrong: 0,
    meaningStreak: 0,
    meaningLastAt: null,
    meaningNextReviewAt: null,
    spellingCorrect: 0,
    spellingWrong: 0,
    spellingStreak: 0,
    spellingLastAt: null,
    spellingNextReviewAt: null,
    spellingHintUsed: 0,
    isFavorite: false,
    isLearned: false
  };
}

export async function getProgress(wordId) {
  const db = await openDb();
  const tx = db.transaction(["progress"], "readonly");
  const store = tx.objectStore("progress");
  const v = await reqToPromise(store.get(wordId));
  await txDone(tx);
  return v || null;
}

export async function putProgress(progress) {
  const db = await openDb();
  const tx = db.transaction(["progress"], "readwrite");
  const store = tx.objectStore("progress");
  store.put(progress);
  await txDone(tx);
}

export async function putProgressMany(progressList) {
  const db = await openDb();
  const tx = db.transaction(["progress"], "readwrite");
  const store = tx.objectStore("progress");
  for (const p of progressList) store.put(p);
  await txDone(tx);
}

export async function getProgressMap(wordIds) {
  const db = await openDb();
  const tx = db.transaction(["progress"], "readonly");
  const store = tx.objectStore("progress");
  const pairs = await Promise.all(
    wordIds.map(async (id) => {
      const v = await reqToPromise(store.get(id));
      return [id, v || null];
    })
  );
  await txDone(tx);
  return new Map(pairs);
}

export async function getAllProgress() {
  const db = await openDb();
  const tx = db.transaction(["progress"], "readonly");
  const store = tx.objectStore("progress");
  const all = await reqToPromise(store.getAll());
  await txDone(tx);
  return all || [];
}

export async function setSetting(key, value) {
  const db = await openDb();
  const tx = db.transaction(["settings"], "readwrite");
  const store = tx.objectStore("settings");
  store.put({ key, value });
  await txDone(tx);
}

export async function setSettingsMany(obj) {
  const db = await openDb();
  const tx = db.transaction(["settings"], "readwrite");
  const store = tx.objectStore("settings");
  for (const [key, value] of Object.entries(obj || {})) {
    store.put({ key, value });
  }
  await txDone(tx);
}

export async function getSetting(key) {
  const db = await openDb();
  const tx = db.transaction(["settings"], "readonly");
  const store = tx.objectStore("settings");
  const row = await reqToPromise(store.get(key));
  await txDone(tx);
  return row ? row.value : undefined;
}

export async function getAllSettings() {
  const db = await openDb();
  const tx = db.transaction(["settings"], "readonly");
  const store = tx.objectStore("settings");
  const rows = await reqToPromise(store.getAll());
  await txDone(tx);
  const out = {};
  for (const r of rows || []) out[r.key] = r.value;
  return out;
}

export async function clearAllData() {
  const db = await openDb();
  const tx = db.transaction(["progress", "settings", "history"], "readwrite");
  tx.objectStore("progress").clear();
  tx.objectStore("settings").clear();
  tx.objectStore("history").clear();
  await txDone(tx);
}

export async function addHistory(event) {
  const db = await openDb();
  const tx = db.transaction(["history"], "readwrite");
  const store = tx.objectStore("history");
  store.add(event);
  await txDone(tx);
}

export async function getRecentHistory(limit = 200) {
  const db = await openDb();
  const tx = db.transaction(["history"], "readonly");
  const store = tx.objectStore("history");
  const out = [];

  await new Promise((resolve, reject) => {
    const req = store.openCursor(null, "prev");
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor || out.length >= limit) return resolve();
      out.push(cursor.value);
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });

  await txDone(tx);
  return out;
}

export async function clearHistory() {
  const db = await openDb();
  const tx = db.transaction(["history"], "readwrite");
  tx.objectStore("history").clear();
  await txDone(tx);
}


