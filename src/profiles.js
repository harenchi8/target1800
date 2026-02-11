const LS_KEY = "t1800_profiles_v1";

function randomId() {
  // URL安全な短ID
  return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
}

export function loadProfiles() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) throw new Error("empty");
    const obj = JSON.parse(raw);
    if (!obj || !Array.isArray(obj.profiles)) throw new Error("invalid");
    return obj;
  } catch {
    // 既存データ互換: legacy = 従来のDB（target1800）
    const init = {
      currentId: "legacy",
      profiles: [{ id: "legacy", name: "ユーザー1（この端末）" }]
    };
    localStorage.setItem(LS_KEY, JSON.stringify(init));
    return init;
  }
}

export function saveProfiles(state) {
  localStorage.setItem(LS_KEY, JSON.stringify(state));
}

export function getCurrentProfile(state) {
  const id = state?.currentId;
  return state?.profiles?.find((p) => p.id === id) || state?.profiles?.[0] || null;
}

export function setCurrentProfileId(state, profileId) {
  const next = { ...state, currentId: profileId };
  saveProfiles(next);
  return next;
}

export function addProfile(state, name) {
  const id = randomId();
  const profile = { id, name: (name || "").trim() || `ユーザー${(state.profiles?.length || 1) + 1}` };
  const next = { ...state, profiles: [...(state.profiles || []), profile], currentId: id };
  saveProfiles(next);
  return next;
}

export function removeProfile(state, profileId) {
  const profiles = (state.profiles || []).filter((p) => p.id !== profileId);
  const currentId = state.currentId === profileId ? (profiles[0]?.id || "legacy") : state.currentId;
  const next = { ...state, profiles, currentId };
  saveProfiles(next);
  return next;
}


