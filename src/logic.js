import { scoreMeaning, scoreSpelling } from "./srs.js";

export const DEFAULT_SETTINGS = {
  showExampleOnMeaningAnswer: true,
  showNotesOnMeaningAnswer: true,
  theme: "school", // school | dark
  // 端末間同期（合言葉）
  // 同期先URLは固定（ユーザー入力不要）
  syncEndpoint: "https://target1800-sync.harench8.workers.dev",
  syncKey: "", // 合言葉（推測されにくい長め推奨）
  syncAuto: true, // 学習の区切りで自動同期
  syncLastAt: null,
  syncLastError: null,
  meaningXNext: "today", // today | tomorrow
  spellingXNext: "today", // today | tomorrow
  spellingPromptMode: "meaning", // meaning | cloze(未実装)
  reviewIncludeTriangle: true
};

export function mergeSettings(raw) {
  const merged = { ...DEFAULT_SETTINGS, ...(raw || {}) };
  // 同期先URLは固定（過去に保存されていても常に固定URLを使う）
  merged.syncEndpoint = DEFAULT_SETTINGS.syncEndpoint;
  return merged;
}

export function normalizeWord(w) {
  return (w || "").trim().toLowerCase();
}

export function isDue(iso, now = new Date()) {
  if (!iso) return false;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return false;
  return d.getTime() <= now.getTime();
}

export function buildCandidateWords(words, filters) {
  const levelsSet = new Set(filters.levels || []);
  const eiken = filters.eiken || "all";
  return words.filter((w) => {
    if (levelsSet.size > 0 && !levelsSet.has(w.level)) return false;
    if (eiken !== "all" && w.eiken !== eiken) return false;
    return true;
  });
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function orderWords(candidates, progressMap, mode, order, now = new Date()) {
  const list = [...candidates];
  if (order === "random") return shuffle(list);

  if (order === "review") {
    const key = mode === "spelling" ? "spellingNextReviewAt" : "meaningNextReviewAt";
    list.sort((a, b) => {
      const pa = progressMap.get(a.id);
      const pb = progressMap.get(b.id);
      const da = pa?.[key] ? new Date(pa[key]).getTime() : Number.POSITIVE_INFINITY;
      const db = pb?.[key] ? new Date(pb[key]).getTime() : Number.POSITIVE_INFINITY;
      return da - db;
    });
    return list;
  }

  if (order === "unstudied") {
    list.sort((a, b) => {
      const pa = progressMap.get(a.id);
      const pb = progressMap.get(b.id);
      const ca =
        mode === "spelling"
          ? (pa?.spellingCorrect || 0) + (pa?.spellingWrong || 0)
          : (pa?.meaningCorrect || 0) + (pa?.meaningPartial || 0) + (pa?.meaningWrong || 0);
      const cb =
        mode === "spelling"
          ? (pb?.spellingCorrect || 0) + (pb?.spellingWrong || 0)
          : (pb?.meaningCorrect || 0) + (pb?.meaningPartial || 0) + (pb?.meaningWrong || 0);
      return ca - cb;
    });
    return list;
  }

  if (order === "weak") {
    list.sort((a, b) => {
      const pa = progressMap.get(a.id);
      const pb = progressMap.get(b.id);
      const sa = mode === "spelling" ? scoreSpelling(pa) : scoreMeaning(pa);
      const sb = mode === "spelling" ? scoreSpelling(pb) : scoreMeaning(pb);
      return sb - sa;
    });
    return list;
  }

  return shuffle(list);
}

export function buildReviewCandidates(words, progressMap, reviewType, includeTriangle) {
  const out = [];
  for (const w of words) {
    const p = progressMap.get(w.id);
    const meaningBad = (p?.meaningWrong || 0) > 0 || (includeTriangle && (p?.meaningPartial || 0) > 0);
    const spellingBad = (p?.spellingWrong || 0) > 0;
    if (reviewType === "meaning" && meaningBad) out.push(w);
    else if (reviewType === "spelling" && spellingBad) out.push(w);
    else if (reviewType === "both" && (meaningBad || spellingBad)) out.push(w);
  }
  return out;
}

export function summarizeDue(progressList, now = new Date()) {
  let meaningDue = 0;
  let spellingDue = 0;
  for (const p of progressList) {
    if (isDue(p.meaningNextReviewAt, now)) meaningDue++;
    if (isDue(p.spellingNextReviewAt, now)) spellingDue++;
  }
  return { meaningDue, spellingDue };
}


