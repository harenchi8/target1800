import { loadWords } from "./data.js";
import { addHistory, clearAllData, clearHistory, createEmptyProgress, deleteProfileDb, getAllProgress, getAllSettings, getProgress, getProgressMap, getRecentHistory, putProgress, setActiveProfileId, setSetting } from "./db.js";
import { parseHash, onRouteChange, go } from "./router.js";
import { clamp, el, fmtDateTime, praise, qs, setMain, toast } from "./ui.js";
import { applyMeaningGrade, applySpellingGrade, scoreMeaning, scoreSpelling } from "./srs.js";
import { buildCandidateWords, buildReviewCandidates, mergeSettings, normalizeWord, orderWords, summarizeDue } from "./logic.js";
import { createSyncManager, isSyncConfigured } from "./sync.js";
import { addProfile, loadProfiles, removeProfile, setCurrentProfileId } from "./profiles.js";

const SESSION_KEY = "t1800_session_v1";

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function praiseOpen() {
  praise(pick(["アプリひらけてえらい！", "今日も来てくれてえらい！", "開けた時点で天才！"]));
}

function praiseSessionStart(mode) {
  const label = mode === "learn" ? "覚える" : mode === "review" ? "復習" : "テスト";
  praise(pick([`${label}を始められてえらい！`, "やる気出してえらい！", "その一歩がすごい！"]));
}

function praiseMeaningGrade(grade) {
  if (grade === "o") return praise(pick(["正解えらい！", "思い出せてえらい！", "最高！その調子！"]));
  if (grade === "triangle") return praise(pick(["△にできてえらい！成長してる！", "あいまいでもOK！続けてえらい！", "正直に自己採点できてえらい！"]));
  return praise(pick(["間違えても挑戦えらい！", "思い出そうとしたのがえらい！", "次で取り返せる！えらい！"]));
}

function praiseSpelling(isCorrect) {
  if (isCorrect) return praise(pick(["スペル正解えらい！", "一発で当ててえらい！", "しっかり書けてえらい！"]));
  return praise(pick(["間違えても入力できてえらい！", "チャレンジえらい！次は当たる！", "最後までやるのがえらい！"]));
}

function praiseSessionDone() {
  praise(pick(["最後までできてえらい！", "セッション完了えらい！", "今日の自分に勝った！えらい！"]));
}

async function logHistory(type, title, meta = {}) {
  try {
    await addHistory({
      ts: new Date().toISOString(),
      type,
      title,
      meta
    });
  } catch {
    // ignore
  }
}

function localDayKey(d = new Date()) {
  // ローカル日付（YYYY-MM-DD）に正規化（連続日数計算用）
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function computeLearnedCount(progressList) {
  // 指示書: meaning ○ 2回以上を「習得」とみなす
  let learned = 0;
  for (const p of progressList) {
    if ((p?.meaningCorrect || 0) >= 2) learned++;
  }
  return learned;
}

function computeStreakDays(historyItems) {
  // 「採点した日」を学習日として連続日数を計算
  const studiedDays = new Set();
  for (const it of historyItems || []) {
    if (it?.type !== "meaning_grade" && it?.type !== "spelling_grade") continue;
    const t = it?.ts ? new Date(it.ts) : null;
    if (!t || Number.isNaN(t.getTime())) continue;
    studiedDays.add(localDayKey(t));
  }
  const todayKey = localDayKey(new Date());
  if (!studiedDays.has(todayKey)) return 0;

  let streak = 0;
  let cursor = new Date();
  while (studiedDays.has(localDayKey(cursor))) {
    streak++;
    cursor = addDays(cursor, -1);
  }
  return streak;
}

function sumTodayXp(historyItems) {
  const today = localDayKey(new Date());
  let xp = 0;
  for (const it of historyItems || []) {
    const t = it?.ts ? new Date(it.ts) : null;
    if (!t || Number.isNaN(t.getTime())) continue;
    if (localDayKey(t) !== today) continue;
    const d = Number(it?.meta?.xpDelta || 0);
    if (!Number.isFinite(d)) continue;
    xp += d;
  }
  return xp;
}

function computeTodayPlan(ctx) {
  const now = new Date();
  const allProgress = [...ctx.progressById.values()];
  const byId = ctx.progressById;

  // 1) 今日の復習（SRS到達分）: meaning/spelling どちらかが期限到達
  const due = [];
  for (const w of ctx.words) {
    const p = byId.get(w.id);
    const md = p?.meaningNextReviewAt ? new Date(p.meaningNextReviewAt).getTime() : null;
    const sd = p?.spellingNextReviewAt ? new Date(p.spellingNextReviewAt).getTime() : null;
    const mDue = md !== null && !Number.isNaN(md) && md <= now.getTime();
    const sDue = sd !== null && !Number.isNaN(sd) && sd <= now.getTime();
    if (mDue || sDue) due.push(w.id);
  }

  // 2) 間違い・△単語（弱点）: 意味の×/△、綴り×
  const weak = [];
  for (const w of ctx.words) {
    const p = byId.get(w.id);
    if (!p) continue;
    const meaningBad = (p.meaningWrong || 0) > 0 || (p.meaningPartial || 0) > 0;
    const spellingBad = (p.spellingWrong || 0) > 0;
    if (meaningBad || spellingBad) weak.push(w.id);
  }

  // 3) 新規単語（10語固定）: 履歴/進捗がほぼ無いもの
  const newCandidates = [];
  for (const w of ctx.words) {
    const p = byId.get(w.id);
    if (!p) {
      newCandidates.push(w.id);
      continue;
    }
    const attempts =
      (p.meaningCorrect || 0) + (p.meaningPartial || 0) + (p.meaningWrong || 0) + (p.spellingCorrect || 0) + (p.spellingWrong || 0);
    if (attempts === 0) newCandidates.push(w.id);
  }

  // 重複排除しつつ順序を「今日の復習→弱点→新規」にする
  const seen = new Set();
  const ordered = [];
  const pushList = (list) => {
    for (const id of list) {
      if (seen.has(id)) continue;
      seen.add(id);
      ordered.push(id);
    }
  };

  // due は nextReviewAt が近い順に
  const dueSorted = [...due].sort((a, b) => {
    const pa = byId.get(a);
    const pb = byId.get(b);
    const da = Math.min(
      pa?.meaningNextReviewAt ? Date.parse(pa.meaningNextReviewAt) || Infinity : Infinity,
      pa?.spellingNextReviewAt ? Date.parse(pa.spellingNextReviewAt) || Infinity : Infinity
    );
    const db = Math.min(
      pb?.meaningNextReviewAt ? Date.parse(pb.meaningNextReviewAt) || Infinity : Infinity,
      pb?.spellingNextReviewAt ? Date.parse(pb.spellingNextReviewAt) || Infinity : Infinity
    );
    return da - db;
  });

  // weak はスコア高い順（意味優先）
  const weakSorted = [...weak].sort((a, b) => {
    const sa = scoreMeaning(byId.get(a) || {}) + scoreSpelling(byId.get(a) || {});
    const sb = scoreMeaning(byId.get(b) || {}) + scoreSpelling(byId.get(b) || {});
    return sb - sa;
  });

  const newSorted = [...newCandidates].sort((a, b) => a - b);

  pushList(dueSorted);
  pushList(weakSorted);
  pushList(newSorted.slice(0, 10));

  return {
    dueCount: dueSorted.length,
    weakCount: weakSorted.length,
    newCount: Math.min(10, newSorted.length),
    total: ordered.length,
    wordIds: ordered,
    learned: computeLearnedCount(allProgress)
  };
}

function speakerIcon() {
  return el(
    "svg",
    { viewBox: "0 0 24 24", ariaHidden: "true" },
    el("path", {
      d: "M3 10v4a2 2 0 0 0 2 2h3l4 3a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1L8 8H5a2 2 0 0 0-2 2zm14.5 2a4.5 4.5 0 0 0-2.2-3.9.9.9 0 0 0-1.3.4.9.9 0 0 0 .4 1.2 2.7 2.7 0 0 1 0 4.6.9.9 0 0 0-.4 1.2.9.9 0 0 0 1.3.4A4.5 4.5 0 0 0 17.5 12zm2.9 0a7.4 7.4 0 0 0-3.7-6.4.9.9 0 0 0-1.2.4.9.9 0 0 0 .4 1.2 5.6 5.6 0 0 1 0 9.6.9.9 0 0 0-.4 1.2.9.9 0 0 0 1.2.4A7.4 7.4 0 0 0 20.4 12z"
    })
  );
}

function getVoicesOnce(timeoutMs = 700) {
  return new Promise((resolve) => {
    if (!("speechSynthesis" in window)) return resolve([]);
    const voicesNow = speechSynthesis.getVoices();
    if (voicesNow && voicesNow.length) return resolve(voicesNow);

    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      speechSynthesis.removeEventListener("voiceschanged", onChange);
      resolve(speechSynthesis.getVoices() || []);
    };
    const onChange = () => finish();
    speechSynthesis.addEventListener("voiceschanged", onChange);
    setTimeout(() => finish(), timeoutMs);
  });
}

async function speakEnglish(text) {
  const t = (text || "").trim();
  if (!t) return;
  if (!("speechSynthesis" in window)) {
    toast("このブラウザは音声読み上げに対応していません");
    return;
  }
  const voices = await getVoicesOnce();
  const pick =
    voices.find((v) => String(v.lang || "").toLowerCase().startsWith("en") && /google|samantha|alex/i.test(v.name)) ||
    voices.find((v) => String(v.lang || "").toLowerCase().startsWith("en")) ||
    null;

  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(t);
    u.lang = "en-US";
    if (pick) u.voice = pick;
    u.rate = 0.95;
    speechSynthesis.speak(u);
  } catch {
    toast("音声の再生に失敗しました");
  }
}

function applyTheme(theme) {
  const t = theme === "dark" ? "dark" : "school";
  document.body.dataset.theme = t;
}

function saveSession(session) {
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

function loadSession() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function clearSession() {
  sessionStorage.removeItem(SESSION_KEY);
}

function downloadJson(filename, obj) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function loadAppContext() {
  const [{ words, levels, eikens }, settingsRaw, progressList] = await Promise.all([
    loadWords(),
    getAllSettings(),
    getAllProgress()
  ]);
  const settings = mergeSettings(settingsRaw);
  applyTheme(settings.theme);
  const progressById = new Map(progressList.map((p) => [p.wordId, p]));
  return { words, levels, eikens, settings, progressById };
}

function layout(title, bodyNode) {
  return el(
    "div",
    { class: "stack" },
    el("div", { class: "stack" }, el("h1", { class: "h1" }, title), bodyNode)
  );
}

function errorCard(message, detail) {
  return el(
    "div",
    { class: "card stack" },
    el("div", { class: "h2" }, "エラー"),
    el("div", { class: "p" }, message),
    detail ? el("pre", { class: "card mono", style: "overflow:auto;" }, String(detail)) : null
  );
}

function homeScreen(ctx) {
  const progressList = [...ctx.progressById.values()];
  const due = summarizeDue(progressList);
  const plan = computeTodayPlan(ctx);

  function section(title, desc, actions) {
    return el(
      "div",
      { class: "card stack homeSection" },
      el("div", { class: "row", style: "justify-content:space-between; align-items:baseline;" }, el("div", { class: "h2" }, title)),
      el("div", { class: "p" }, desc),
      el("div", { class: "grid2" }, ...actions)
    );
  }

  // 感情が動くステータス（簡易）
  // streak / xp は履歴から計算
  // ※履歴が多いと重いので200件だけ見る
  const historyItems = ctx._homeHistory || [];
  const streak = computeStreakDays(historyItems);
  const xpToday = sumTodayXp(historyItems);

  const stats = el(
    "div",
    { class: "statGrid" },
    el("div", { class: "statCard" }, el("div", { class: "statLabel" }, "🎯 習得"), el("div", { class: "statValue" }, `${plan.learned} / ${ctx.words.length}語`)),
    el("div", { class: "statCard" }, el("div", { class: "statLabel" }, "🔥 連続学習"), el("div", { class: "statValue" }, `${streak}日`)),
    el("div", { class: "statCard" }, el("div", { class: "statLabel" }, "📚 今日の復習"), el("div", { class: "statValue" }, `${due.meaningDue + due.spellingDue}語`))
  );

  const stats2 = el(
    "div",
    { class: "row" },
    el("span", { class: "pill" }, `✨ 今日: +${xpToday}XP`),
    el("span", { class: "pill" }, plan.total > 0 ? `今日はあと${plan.total}問でOK` : "🎉 今日分完了！")
  );

  const hero = el(
    "div",
    { class: "card stack" },
    el(
      "button",
      {
        class: "btn btnHero",
        type: "button",
        onclick: () => {
          const session = {
            mode: "today",
            runMode: "meaning",
            filters: { levels: [], eiken: "all" },
            order: "today",
            wordIds: plan.wordIds,
            idx: 0,
            answerShown: false,
            spellingChecked: false,
            spellingWasCorrect: null
          };
          saveSession(session);
          praiseSessionStart("today");
          logHistory("session_start", "今日の学習開始", { mode: "today", count: plan.wordIds.length });
          go("#/test-meaning");
        }
      },
      "🔥 今日の学習を開始"
    ),
    el("div", { class: "help" }, "今日の復習 → 弱点 → 新規10語を自動で出します。")
  );

  const sections = el(
    "div",
    { class: "stack" },
    section("② テスト（思い出す）", "見ずに思い出す → 最強の暗記", [
      el("a", { class: "btn btnPrimary", href: "#/setup?mode=meaning" }, "テスト（意味）"),
      el("a", { class: "btn btnPrimary", href: "#/setup?mode=spelling" }, "テスト（綴り）")
    ]),
    section("③ 🔥 弱点だけやる", "×と△だけ出ます。いちばん伸びるモード。", [
      el("a", { class: "btn btnPrimary", href: "#/setup?mode=review" }, "🔥 弱点だけやる"),
      el("a", { class: "btn", href: "#/analysis" }, "苦手・正答率を見る")
    ]),
    section("① 覚える（カード）", "最初に見るだけ。テスト前の準備に。", [
      el("a", { class: "btn", href: "#/setup?mode=learn" }, "覚える（カード）"),
      el("a", { class: "btn", href: "#/settings" }, "設定")
    ])
  );

  const help = el(
    "div",
    { class: "card stack" },
    el("div", { class: "h2" }, "使い方（最短）"),
    el(
      "div",
      { class: "p" },
      "「テスト（意味）」→「答えを見る」→ ○/△/× を確定、で記録とSRSが進みます。"
    ),
    el("div", { class: "p" }, "「綴り」は完全一致（小文字化・前後空白除去）で自動判定です。")
  );

  return layout("ホーム", el("div", { class: "stack" }, stats, stats2, hero, sections, help));
}

function setupScreen(ctx, mode) {
  const titleByMode = {
    learn: "セッション作成：覚える（カード）",
    meaning: "セッション作成：テスト（意味）",
    spelling: "セッション作成：テスト（綴り）",
    review: "セッション作成：間違い集中（復習）"
  };

  const defaultLevels = ctx.levels.length ? ctx.levels.slice(0, Math.min(3, ctx.levels.length)) : [];

  const levelsWrap = el("div", { class: "card stack" }, el("div", { class: "h2" }, "レベル（複数選択）"));
  const levelChecks = [];
  for (const lv of ctx.levels) {
    const id = `lv_${lv}`;
    const input = el("input", { type: "checkbox", id, value: lv, checked: defaultLevels.includes(lv) ? "checked" : null });
    levelChecks.push(input);
    levelsWrap.appendChild(
      el("label", { class: "row", for: id, style: "gap:10px; align-items:flex-start;" }, input, el("span", {}, lv))
    );
  }
  if (ctx.levels.length === 0) {
    levelsWrap.appendChild(el("div", { class: "p" }, "レベル情報がありません。"));
  }

  const eikenField = el(
    "div",
    { class: "field" },
    el("label", {}, "英検（任意）"),
    (() => {
      const sel = el("select", { id: "eiken" }, el("option", { value: "all" }, "指定なし（すべて）"));
      for (const e of ctx.eikens) sel.appendChild(el("option", { value: e }, e));
      return sel;
    })()
  );

  const orderSel = el(
    "div",
    { class: "field" },
    el("label", {}, "出題順"),
    el(
      "select",
      { id: "order" },
      el("option", { value: "random" }, "完全ランダム"),
      el("option", { value: "weak" }, "苦手優先（wrong/△が多い）"),
      el("option", { value: "unstudied" }, "未学習優先（履歴が少ない）"),
      el("option", { value: "review" }, "復習優先（nextReviewAtが近い）")
    )
  );

  const countField = el(
    "div",
    { class: "field" },
    el("label", {}, "問題数"),
    el("input", { id: "count", type: "number", min: "1", step: "1", value: "10", inputmode: "numeric" }),
    el("div", { class: "help" }, "10/20/50 以外も入力できます。")
  );

  const reviewExtra =
    mode !== "review"
      ? null
      : el(
          "div",
          { class: "card stack" },
          el("div", { class: "h2" }, "復習条件"),
          el(
            "div",
            { class: "field" },
            el("label", {}, "対象"),
            el(
              "select",
              { id: "reviewType" },
              el("option", { value: "meaning" }, "意味（×/△）"),
              el("option", { value: "spelling" }, "綴り（×）"),
              el("option", { value: "both" }, "両方（どちらか×/△/×）")
            )
          ),
          el(
            "label",
            { class: "row", style: "gap:10px;" },
            el("input", { id: "includeTriangle", type: "checkbox", checked: ctx.settings.reviewIncludeTriangle ? "checked" : null }),
            el("span", {}, "△を含める（意味）")
          )
        );

  const form = el(
    "form",
    {
      class: "stack",
      onsubmit: async (ev) => {
        ev.preventDefault();
        const levels = levelChecks.filter((c) => c.checked).map((c) => c.value);
        const eiken = qs("#eiken", form)?.value || "all";
        const order = qs("#order", form)?.value || "random";
        const count = Math.max(1, Number(qs("#count", form)?.value || 10));

        const filters = { levels, eiken };
        const baseCandidates = buildCandidateWords(ctx.words, filters);
        const progressMap = await getProgressMap(baseCandidates.map((w) => w.id));

        let candidates = baseCandidates;
        let runMode = mode;
        if (mode === "review") {
          const reviewType = qs("#reviewType", form)?.value || "meaning";
          const includeTriangle = !!qs("#includeTriangle", form)?.checked;
          candidates = buildReviewCandidates(baseCandidates, progressMap, reviewType, includeTriangle);
          runMode = reviewType === "spelling" ? "spelling" : "meaning";
        }

        const ordered = orderWords(candidates, progressMap, runMode, order);
        const picked = ordered.slice(0, count).map((w) => w.id);
        if (picked.length === 0) {
          toast("条件に合う単語がありませんでした");
          return;
        }

        const session = {
          mode,
          runMode,
          filters,
          order,
          wordIds: picked,
          idx: 0,
          answerShown: false,
          spellingChecked: false,
          spellingWasCorrect: null
        };
        saveSession(session);
        praiseSessionStart(mode);
        logHistory("session_start", "セッション開始", { mode, runMode, count: picked.length, order, filters });

        if (mode === "learn") go("#/learn");
        else if (runMode === "spelling") go("#/test-spelling");
        else go("#/test-meaning");
      }
    },
    levelsWrap,
    el("div", { class: "card stack" }, eikenField),
    el("div", { class: "card stack" }, orderSel, countField),
    reviewExtra,
    el(
      "div",
      { class: "row" },
      el("button", { class: "btn btnPrimary", type: "submit" }, "開始"),
      el("a", { class: "btn", href: "#/home" }, "戻る")
    )
  );

  return layout(titleByMode[mode] || "セッション作成", form);
}

async function getWordAndProgress(ctx, wordId) {
  const word = ctx.words.find((w) => w.id === wordId);
  if (!word) return { word: null, progress: null };
  const existing = ctx.progressById.get(wordId) || null;
  const progress = existing || (await getProgress(wordId)) || null;
  if (progress) ctx.progressById.set(wordId, progress);
  return { word, progress };
}

function sessionGuard(session) {
  if (!session || !Array.isArray(session.wordIds) || session.wordIds.length === 0) {
    return layout(
      "セッションがありません",
      el(
        "div",
        { class: "card stack" },
        el("div", { class: "p" }, "ホームからセッションを作成してください。"),
        el("a", { class: "btn btnPrimary", href: "#/home" }, "ホームへ")
      )
    );
  }
  return null;
}

async function learnScreen(ctx) {
  const session = loadSession();
  const guard = sessionGuard(session);
  if (guard) return guard;

  const idx = clamp(session.idx || 0, 0, session.wordIds.length - 1);
  session.idx = idx;
  saveSession(session);

  const wordId = session.wordIds[idx];
  const { word, progress } = await getWordAndProgress(ctx, wordId);
  if (!word) return errorCard("単語が見つかりませんでした");
  const p = progress || createEmptyProgress(wordId);

  const meta = el(
    "div",
    { class: "row" },
    el("span", { class: "pill" }, `${idx + 1} / ${session.wordIds.length}`),
    word.level ? el("span", { class: "pill" }, word.level) : null,
    word.eiken ? el("span", { class: "pill" }, word.eiken) : null
  );

  const flags = el(
    "div",
    { class: "row" },
    el(
      "button",
      {
        class: "btn",
        onclick: async () => {
          const next = { ...p, isFavorite: !p.isFavorite, updatedAt: new Date().toISOString() };
          await putProgress(next);
          ctx.progressById.set(wordId, next);
          toast(next.isFavorite ? "お気に入りに追加" : "お気に入りを解除");
          praise(next.isFavorite ? "お気に入りにできてえらい！" : "見直せてえらい！");
          logHistory("flag_favorite", next.isFavorite ? "お気に入りに追加" : "お気に入りを解除", { wordId, word: word.word });
          sync?.schedulePush("after-flag");
          render();
        }
      },
      p.isFavorite ? "★ お気に入り" : "☆ お気に入り"
    ),
    el(
      "button",
      {
        class: "btn",
        onclick: async () => {
          const next = { ...p, isLearned: !p.isLearned, updatedAt: new Date().toISOString() };
          await putProgress(next);
          ctx.progressById.set(wordId, next);
          toast(next.isLearned ? "「覚えた」にチェック" : "「覚えた」を解除");
          praise(next.isLearned ? "覚えたにできてえらい！" : "調整できてえらい！");
          logHistory("flag_learned", next.isLearned ? "「覚えた」にした" : "「覚えた」を解除", { wordId, word: word.word });
          sync?.schedulePush("after-flag");
          render();
        }
      },
      p.isLearned ? "✓ 覚えた" : "□ 覚えた"
    )
  );

  const card = el(
    "div",
    { class: "card stack" },
    meta,
    el(
      "div",
      { class: "row", style: "align-items:center; justify-content:space-between;" },
      el("div", { class: "word" }, word.word),
      el(
        "button",
        {
          class: "iconBtn",
          type: "button",
          ariaLabel: "発音を再生",
          onclick: () => speakEnglish(word.word)
        },
        speakerIcon()
      )
    ),
    word.phonetic ? el("div", { class: "phonetic" }, word.phonetic) : null,
    el("div", { class: "sep" }),
    el("div", { class: "h2" }, "意味"),
    el("div", { class: "preline" }, word.meaning_ja || "—"),
    el("div", { class: "h2" }, "例文"),
    el("div", {}, word.example_en || "—"),
    el("div", { class: "muted" }, word.example_ja || "—"),
    el("div", { class: "h2" }, "用法・特記事項"),
    el("div", { class: "preline muted" }, word.notes || "—")
  );

  const nav = el(
    "div",
    { class: "row" },
    el(
      "button",
      {
        class: "btn",
        disabled: idx === 0 ? "disabled" : null,
        onclick: () => {
          session.idx = clamp(idx - 1, 0, session.wordIds.length - 1);
          saveSession(session);
          render();
        }
      },
      "前へ"
    ),
    el(
      "button",
      {
        class: "btn btnPrimary",
        onclick: () => {
          session.idx = clamp(idx + 1, 0, session.wordIds.length - 1);
          saveSession(session);
          render();
        }
      },
      "次へ"
    ),
    el(
      "button",
      {
        class: "btn",
        onclick: () => {
          clearSession();
          toast("セッションを終了しました");
          sync?.schedulePush("after-session-end");
          logHistory("session_end", "セッション終了");
          go("#/home");
        }
      },
      "終了"
    )
  );

  return layout("覚える（カード）", el("div", { class: "stack" }, flags, card, nav));
}

async function meaningTestScreen(ctx) {
  const session = loadSession();
  const guard = sessionGuard(session);
  if (guard) return guard;

  const idx = clamp(session.idx || 0, 0, session.wordIds.length - 1);
  session.idx = idx;
  const wordId = session.wordIds[idx];
  const { word, progress } = await getWordAndProgress(ctx, wordId);
  if (!word) return errorCard("単語が見つかりませんでした");
  const p0 = progress || createEmptyProgress(wordId);

  const meta = el(
    "div",
    { class: "row" },
    el("span", { class: "pill" }, `${idx + 1} / ${session.wordIds.length}`),
    word.level ? el("span", { class: "pill" }, word.level) : null,
    word.eiken ? el("span", { class: "pill" }, word.eiken) : null
  );

  const input = el("textarea", { id: "ans", placeholder: "日本語で意味を入力（必須）", required: "required" });
  const revealBtn = el("button", { class: "btn btnPrimary", type: "button" }, "答えを見る");
  const answerArea = el("div", { class: "card stack", style: "display:none;" });

  function showAnswer() {
    session.answerShown = true;
    saveSession(session);
    answerArea.style.display = "block";
    answerArea.innerHTML = "";
    answerArea.appendChild(el("div", { class: "h2" }, "正解"));
    answerArea.appendChild(el("div", { class: "preline" }, word.meaning_ja || "—"));
    if (ctx.settings.showExampleOnMeaningAnswer) {
      answerArea.appendChild(el("div", { class: "h2" }, "例文"));
      answerArea.appendChild(el("div", {}, word.example_en || "—"));
      answerArea.appendChild(el("div", { class: "muted" }, word.example_ja || "—"));
    }
    if (ctx.settings.showNotesOnMeaningAnswer) {
      answerArea.appendChild(el("div", { class: "h2" }, "用法・特記事項"));
      answerArea.appendChild(el("div", { class: "preline muted" }, word.notes || "—"));
    }
    gradeRow.style.display = "flex";
    revealBtn.disabled = "disabled";
    input.disabled = "disabled";
  }

  revealBtn.addEventListener("click", () => {
    if (!input.value.trim()) {
      toast("意味を入力してください");
      input.focus();
      return;
    }
    showAnswer();
  });

  const gradeRow = el(
    "div",
    { class: "row", style: "display:none;" },
    el(
      "button",
      {
        class: "btn btnOk",
        type: "button",
        onclick: async () => {
          const now = new Date();
          const p1 = applyMeaningGrade(p0, "o", now, ctx.settings);
          await putProgress(p1);
          ctx.progressById.set(wordId, p1);
          praiseMeaningGrade("o");
          logHistory("meaning_grade", "意味テスト：○", { wordId, word: word.word, xpDelta: 5 });
          sync?.schedulePush("after-meaning-grade");
          next();
        }
      },
      el("span", { class: "markOk" }, "○"),
      " 正しい"
    ),
    el(
      "button",
      {
        class: "btn btnWarn",
        type: "button",
        onclick: async () => {
          const now = new Date();
          const p1 = applyMeaningGrade(p0, "triangle", now, ctx.settings);
          await putProgress(p1);
          ctx.progressById.set(wordId, p1);
          praiseMeaningGrade("triangle");
          logHistory("meaning_grade", "意味テスト：△", { wordId, word: word.word, xpDelta: 2 });
          sync?.schedulePush("after-meaning-grade");
          next();
        }
      },
      el("span", { class: "markPartial" }, "△"),
      " あいまい"
    ),
    el(
      "button",
      {
        class: "btn btnBad",
        type: "button",
        onclick: async () => {
          const now = new Date();
          const p1 = applyMeaningGrade(p0, "x", now, ctx.settings);
          await putProgress(p1);
          ctx.progressById.set(wordId, p1);
          praiseMeaningGrade("x");
          logHistory("meaning_grade", "意味テスト：×", { wordId, word: word.word, xpDelta: 1 });
          sync?.schedulePush("after-meaning-grade");
          next();
        }
      },
      el("span", { class: "markBad" }, "×"),
      " 不正解"
    )
  );

  function next() {
    session.idx = clamp(idx + 1, 0, session.wordIds.length - 1);
    session.answerShown = false;
    saveSession(session);
    if (idx + 1 >= session.wordIds.length) {
      toast("セッション完了");
      praiseSessionDone();
      logHistory("session_done", "セッション完了", { mode: session.mode, runMode: session.runMode, count: session.wordIds.length });
      clearSession();
      go("#/home");
      return;
    }
    render();
  }

  const top = el(
    "div",
    { class: "card stack" },
    meta,
    el(
      "div",
      { class: "row", style: "align-items:center; justify-content:space-between;" },
      el("div", { class: "word" }, word.word),
      el(
        "button",
        {
          class: "iconBtn",
          type: "button",
          ariaLabel: "発音を再生",
          onclick: () => speakEnglish(word.word)
        },
        speakerIcon()
      )
    ),
    word.phonetic ? el("div", { class: "phonetic" }, word.phonetic) : null,
    el("div", { class: "sep" }),
    el("div", { class: "h2" }, "例文（英）"),
    el("div", {}, word.example_en || "—")
  );

  const form = el(
    "div",
    { class: "stack" },
    top,
    el("div", { class: "card stack" }, el("div", { class: "field" }, el("label", {}, "あなたの回答"), input), el("div", { class: "row" }, revealBtn, el("span", { class: "help" }, "採点は「答えを見る」後に表示されます"))),
    answerArea,
    gradeRow,
    el(
      "div",
      { class: "row" },
      el("a", { class: "btn", href: "#/home" }, "中断してホームへ"),
      el(
        "button",
        {
          class: "btn",
          type: "button",
          onclick: () => {
            clearSession();
            toast("セッションを終了しました");
            go("#/home");
          }
        },
        "セッション終了"
      )
    )
  );

  if (session.answerShown) queueMicrotask(showAnswer);
  return layout("テスト（意味）", form);
}

async function spellingTestScreen(ctx) {
  const session = loadSession();
  const guard = sessionGuard(session);
  if (guard) return guard;

  const idx = clamp(session.idx || 0, 0, session.wordIds.length - 1);
  session.idx = idx;
  const wordId = session.wordIds[idx];
  const { word, progress } = await getWordAndProgress(ctx, wordId);
  if (!word) return errorCard("単語が見つかりませんでした");
  const p0 = progress || createEmptyProgress(wordId);

  const meta = el(
    "div",
    { class: "row" },
    el("span", { class: "pill" }, `${idx + 1} / ${session.wordIds.length}`),
    word.level ? el("span", { class: "pill" }, word.level) : null,
    word.eiken ? el("span", { class: "pill" }, word.eiken) : null
  );

  const prompt = el(
    "div",
    { class: "card stack" },
    meta,
    el("div", { class: "h2" }, "日本語 → 英単語（入力）"),
    el("div", { class: "preline" }, word.meaning_ja || "—"),
    ctx.settings.showExampleOnMeaningAnswer ? el("div", { class: "muted" }, "（例文は設定でON/OFF：今は意味テスト側のみ制御）") : null
  );

  const input = el("input", { id: "spell", placeholder: "英単語を入力", autocomplete: "off", autocapitalize: "none", spellcheck: "false" });
  const checkBtn = el("button", { class: "btn btnPrimary", type: "button" }, "判定する");
  const result = el("div", { class: "card stack", style: "display:none;" });
  const nextBtn = el("button", { class: "btn btnPrimary", type: "button", style: "display:none;" }, "次へ");

  function showResult(isCorrect) {
    session.spellingChecked = true;
    session.spellingWasCorrect = isCorrect;
    saveSession(session);

    result.style.display = "block";
    result.innerHTML = "";
    result.appendChild(
      el(
        "div",
        { class: "h2" },
        isCorrect ? el("span", { class: "markOk" }, "○") : el("span", { class: "markBad" }, "×"),
        isCorrect ? " 正解" : " 不正解"
      )
    );
    result.appendChild(el("div", {}, el("span", { class: "muted" }, "正解: "), el("span", { class: "mono" }, word.word)));
    if (word.phonetic) result.appendChild(el("div", { class: "phonetic" }, word.phonetic));
    nextBtn.style.display = "inline-flex";
    checkBtn.disabled = "disabled";
    input.disabled = "disabled";
  }

  async function commit(isCorrect) {
    const now = new Date();
    const p1 = applySpellingGrade(p0, isCorrect ? "o" : "x", now, ctx.settings);
    await putProgress(p1);
    ctx.progressById.set(wordId, p1);
    sync?.schedulePush("after-spelling-grade");
  }

  checkBtn.addEventListener("click", async () => {
    const user = normalizeWord(input.value);
    if (!user) {
      toast("英単語を入力してください");
      input.focus();
      return;
    }
    const isCorrect = user === normalizeWord(word.word);
    await commit(isCorrect);
    praiseSpelling(isCorrect);
    logHistory("spelling_grade", `綴りテスト：${isCorrect ? "○" : "×"}`, { wordId, word: word.word, xpDelta: isCorrect ? 6 : 1 });
    showResult(isCorrect);
  });

  nextBtn.addEventListener("click", () => {
    session.idx = clamp(idx + 1, 0, session.wordIds.length - 1);
    session.spellingChecked = false;
    session.spellingWasCorrect = null;
    saveSession(session);
    if (idx + 1 >= session.wordIds.length) {
      toast("セッション完了");
      praiseSessionDone();
      clearSession();
      sync?.schedulePush("after-session-end");
      logHistory("session_done", "セッション完了", { mode: session.mode, runMode: session.runMode, count: session.wordIds.length });
      go("#/home");
      return;
    }
    render();
  });

  if (session.spellingChecked) {
    queueMicrotask(() => showResult(!!session.spellingWasCorrect));
  }

  return layout(
    "テスト（綴り）",
    el(
      "div",
      { class: "stack" },
      prompt,
      el("div", { class: "card stack" }, el("div", { class: "field" }, el("label", {}, "あなたの回答"), input), el("div", { class: "row" }, checkBtn, nextBtn, el("span", { class: "help" }, "EnterキーでもOK"))),
      result,
      el(
        "div",
        { class: "row" },
        el("a", { class: "btn", href: "#/home" }, "中断してホームへ"),
        el(
          "button",
          {
            class: "btn",
            type: "button",
            onclick: () => {
              clearSession();
              toast("セッションを終了しました");
              go("#/home");
            }
          },
          "セッション終了"
        )
      )
    )
  );
}

function analysisScreen(ctx) {
  const progress = [...ctx.progressById.values()];
  const due = summarizeDue(progress);

  const byId = new Map(ctx.words.map((w) => [w.id, w]));

  const meaningTop = [...progress]
    .map((p) => ({ p, s: scoreMeaning(p) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, 20);

  const spellingTop = [...progress]
    .map((p) => ({ p, s: scoreSpelling(p) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, 20);

  const levelStats = new Map();
  for (const w of ctx.words) {
    const lv = w.level || "（不明）";
    const p = ctx.progressById.get(w.id);
    if (!levelStats.has(lv)) levelStats.set(lv, { lv, mTotal: 0, mOk: 0, sTotal: 0, sOk: 0 });
    const st = levelStats.get(lv);
    const mTotal = (p?.meaningCorrect || 0) + (p?.meaningPartial || 0) + (p?.meaningWrong || 0);
    const sTotal = (p?.spellingCorrect || 0) + (p?.spellingWrong || 0);
    st.mTotal += mTotal;
    st.mOk += p?.meaningCorrect || 0;
    st.sTotal += sTotal;
    st.sOk += p?.spellingCorrect || 0;
  }
  const levelRows = [...levelStats.values()].sort((a, b) => a.lv.localeCompare(b.lv));

  function topList(items, label) {
    return el(
      "div",
      { class: "card stack" },
      el("div", { class: "h2" }, label),
      items.length === 0
        ? el("div", { class: "p" }, "まだデータがありません。")
        : el(
            "div",
            { class: "stack" },
            ...items.map(({ p, s }) => {
              const w = byId.get(p.wordId);
              return el(
                "div",
                { class: "row" },
                el("span", { class: "pill mono" }, `score ${s}`),
                el("span", { class: "mono" }, w?.word || `#${p.wordId}`),
                el("span", { class: "muted" }, w?.meaning_ja ? `— ${w.meaning_ja}` : "")
              );
            })
          )
    );
  }

  const levelTable = el(
    "div",
    { class: "card stack" },
    el("div", { class: "h2" }, "LEVEL別 正答率（累計）"),
    el(
      "div",
      { class: "stack" },
      ...levelRows.map((r) => {
        const mRate = r.mTotal ? Math.round((r.mOk / r.mTotal) * 100) : 0;
        const sRate = r.sTotal ? Math.round((r.sOk / r.sTotal) * 100) : 0;
        return el(
          "div",
          { class: "row" },
          el("span", { class: "pill" }, r.lv),
          el("span", { class: "muted" }, `意味: ${mRate}%（${r.mOk}/${r.mTotal}）`),
          el("span", { class: "muted" }, `綴り: ${sRate}%（${r.sOk}/${r.sTotal}）`)
        );
      })
    )
  );

  return layout(
    "分析",
    el(
      "div",
      { class: "stack" },
      el("div", { class: "row" }, el("span", { class: "pill" }, `今日の復習（意味）: ${due.meaningDue}`), el("span", { class: "pill" }, `今日の復習（綴り）: ${due.spellingDue}`)),
      el("div", { class: "grid2" }, topList(meaningTop, "苦手TOP（意味）"), topList(spellingTop, "苦手TOP（綴り）")),
      levelTable
    )
  );
}

async function historyScreen() {
  const items = await getRecentHistory(250);
  const list =
    items.length === 0
      ? el("div", { class: "card stack" }, el("div", { class: "p" }, "まだ履歴がありません。"))
      : el(
          "div",
          { class: "historyList" },
          ...items.map((it) => {
            const t = it?.ts ? new Date(it.ts) : null;
            const time = t && !Number.isNaN(t.getTime()) ? t.toLocaleString("ja-JP", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—";
            const metaWord = it?.meta?.word ? `単語: ${it.meta.word}` : "";
            return el(
              "div",
              { class: "historyItem" },
              el("div", { class: "historyTime" }, time),
              el(
                "div",
                { class: "historyMain" },
                el("div", { class: "historyTitle" }, it?.title || "—"),
                metaWord ? el("div", { class: "historyMeta" }, metaWord) : null
              )
            );
          })
        );

  const actions = el(
    "div",
    { class: "row" },
    el(
      "button",
      {
        class: "btn btnBad",
        type: "button",
        onclick: async () => {
          if (!confirm("履歴を全削除します。よろしいですか？")) return;
          await clearHistory();
          toast("履歴を削除しました");
          await render();
        }
      },
      "履歴を全削除"
    )
  );

  return layout("履歴", el("div", { class: "stack" }, actions, list));
}

function settingsScreen(ctx) {
  const s = ctx.settings;
  const profiles = profilesState?.profiles || [{ id: "legacy", name: "ユーザー1（この端末）" }];
  const currentProfileId = profilesState?.currentId || "legacy";

  function toggleRow(label, key) {
    const input = el("input", { type: "checkbox", checked: s[key] ? "checked" : null });
    input.addEventListener("change", async () => {
      s[key] = !!input.checked;
      await setSetting(key, s[key]);
      toast("設定を保存しました");
      if (key.startsWith("sync")) sync?.schedulePush("after-setting");
    });
    return el("label", { class: "row", style: "gap:10px;" }, input, el("span", {}, label));
  }

  function selectRow(label, key, options) {
    const sel = el("select", {});
    for (const [value, text] of options) {
      sel.appendChild(el("option", { value, selected: s[key] === value ? "selected" : null }, text));
    }
    sel.addEventListener("change", async () => {
      s[key] = sel.value;
      await setSetting(key, s[key]);
      if (key === "theme") applyTheme(s[key]);
      toast("設定を保存しました");
      if (key.startsWith("sync")) sync?.schedulePush("after-setting");
    });
    return el("div", { class: "field" }, el("label", {}, label), sel);
  }

  function textRow(label, key, placeholder = "") {
    const input = el("input", { type: "text", value: s[key] || "", placeholder });
    input.addEventListener("change", async () => {
      s[key] = input.value;
      await setSetting(key, s[key]);
      toast("設定を保存しました");
    });
    return el("div", { class: "field" }, el("label", {}, label), input);
  }

  function passwordRow(label, key, placeholder = "") {
    // 合言葉は保存されていても入力欄に埋め戻さない（切替時の混乱/覗き見対策）
    const input = el("input", { type: "password", value: "", placeholder });
    input.addEventListener("change", async () => {
      const v = String(input.value || "").trim();
      if (!v) return;
      s[key] = v;
      await setSetting(key, v);
      input.value = "";
      toast("合言葉を更新しました");
    });
    return el(
      "div",
      { class: "field" },
      el("label", {}, label),
      input,
      el("div", { class: "help" }, "※合言葉は推測されにくい長めの文字列にしてください。")
    );
  }

  const card = el(
    "div",
    { class: "stack" },
    el(
      "div",
      { class: "card stack" },
      el("div", { class: "h2" }, "ユーザー"),
      el(
        "div",
        { class: "stack" },
        ...profiles.map((p) => {
          const radio = el("input", { type: "radio", name: "profile", checked: p.id === currentProfileId ? "checked" : null });
          radio.addEventListener("change", async () => {
            if (!radio.checked) return;
            profilesState = setCurrentProfileId(loadProfiles(), p.id);
            setActiveProfileId(p.id);
            ctxCache = null;
            toast(`ユーザー切替: ${p.name}`);
            await render();
          });
          return el("label", { class: "row", style: "gap:10px;" }, radio, el("span", {}, p.name));
        })
      ),
      el(
        "div",
        { class: "row" },
        el(
          "button",
          {
            class: "btn btnPrimary",
            type: "button",
            onclick: async () => {
              const name = prompt("追加するユーザー名（例：太郎）");
              if (name === null) return;
              profilesState = addProfile(loadProfiles(), name);
              setActiveProfileId(profilesState.currentId);
              // 追加直後に合言葉も設定できるようにする（ユーザー別）
              const key = prompt("このユーザーの合言葉（端末間同期用。空なら後で設定）");
              if (key !== null && String(key).trim()) {
                await setSetting("syncKey", String(key).trim());
              }
              ctxCache = null;
              toast("ユーザーを追加しました");
              await render();
            }
          },
          "ユーザーを追加"
        ),
        el(
          "button",
          {
            class: "btn btnBad",
            type: "button",
            disabled: profiles.length <= 1 ? "disabled" : null,
            onclick: async () => {
              const p = profiles.find((x) => x.id === currentProfileId);
              if (!p) return;
              if (!confirm(`ユーザー「${p.name}」を削除します（この端末の学習データも削除）。よろしいですか？`)) return;
              // legacyは削除不可（既存DB保護）
              if (p.id === "legacy") {
                toast("ユーザー1は削除できません");
                return;
              }
              await deleteProfileDb(p.id);
              profilesState = removeProfile(loadProfiles(), p.id);
              setActiveProfileId(profilesState.currentId);
              ctxCache = null;
              toast("ユーザーを削除しました");
              await render();
            }
          },
          "このユーザーを削除"
        )
      ),
      el("div", { class: "help" }, "※ユーザーごとに学習データ・合言葉同期設定が別になります。")
    ),
    el(
      "div",
      { class: "card stack" },
      el("div", { class: "h2" }, "端末間同期（合言葉）"),
      el("div", { class: "p" }, `同期先: ${s.syncEndpoint}`),
      el("div", { class: "p" }, `合言葉: ${s.syncKey ? "設定済み" : "未設定"}`),
      passwordRow("合言葉", "syncKey", "この端末に保存されます"),
      toggleRow("学習の区切りで自動同期する（おすすめ）", "syncAuto"),
      el(
        "div",
        { class: "row" },
        el(
          "button",
          {
            class: "btn",
            type: "button",
            onclick: async () => {
              try {
                const res = await fetch(`${s.syncEndpoint}/health`, { method: "GET" });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                toast("接続OK（/health）");
              } catch (e) {
                const msg = e?.message || String(e);
                toast(`接続NG: ${msg}`);
              }
            }
          },
          "接続テスト"
        ),
        el(
          "button",
          {
            class: "btn",
            type: "button",
            onclick: async () => {
              if (!confirm("このユーザーの合言葉をクリアします。よろしいですか？")) return;
              s.syncKey = "";
              await setSetting("syncKey", "");
              toast("合言葉をクリアしました");
              render();
            }
          },
          "合言葉をクリア"
        ),
        el(
          "button",
          {
            class: "btn btnPrimary",
            type: "button",
            onclick: async () => {
              try {
                if (!isSyncConfigured(s)) {
                  toast("同期先URLと合言葉を設定してください");
                  return;
                }
                await sync?.pushNow("manual");
              } catch (e) {
                const msgRaw = e?.message || String(e);
                const msg =
                  msgRaw === "Failed to fetch"
                    ? `Failed to fetch（同期先に接続できません）: ${s.syncEndpoint}（WorkerのURL/デプロイ/CORSを確認）`
                    : msgRaw;
                await setSetting("syncLastError", msg);
                s.syncLastError = msg;
                toast(`同期失敗: ${msg}`);
              } finally {
                render();
              }
            }
          },
          "今すぐ同期"
        ),
        el(
          "button",
          {
            class: "btn",
            type: "button",
            onclick: async () => {
              if (!confirm("クラウドのデータを取り込みます（ローカルとマージ）。よろしいですか？")) return;
              try {
                if (!isSyncConfigured(s)) {
                  toast("同期先URLと合言葉を設定してください");
                  return;
                }
                await sync?.pullAndRestore();
              } catch (e) {
                const msgRaw = e?.message || String(e);
                const msg =
                  msgRaw === "Failed to fetch"
                    ? `Failed to fetch（同期先に接続できません）: ${s.syncEndpoint}（WorkerのURL/デプロイ/CORSを確認）`
                    : msgRaw;
                await setSetting("syncLastError", msg);
                s.syncLastError = msg;
                toast(`復元失敗: ${msg}`);
              } finally {
                ctxCache = null; // 設定/進捗を読み直す
                await render();
              }
            }
          },
          "クラウドから復元"
        )
      ),
      el("div", { class: "help" }, "同期データは端末側で暗号化して保存します（クラウド側に合言葉は送信しません）。"),
      el("div", { class: "help" }, `最終同期: ${fmtDateTime(s.syncLastAt)} / エラー: ${s.syncLastError || "なし"}`)
    ),
    el(
      "div",
      { class: "card stack" },
      el("div", { class: "h2" }, "テーマ"),
      selectRow("見た目", "theme", [
        ["school", "ノート風（おすすめ）"],
        ["dark", "ダーク"]
      ])
    ),
    el(
      "div",
      { class: "card stack" },
      el("div", { class: "h2" }, "表示（意味テストの正解表示）"),
      toggleRow("例文を表示する", "showExampleOnMeaningAnswer"),
      toggleRow("用法・特記事項を表示する", "showNotesOnMeaningAnswer")
    ),
    el(
      "div",
      { class: "card stack" },
      el("div", { class: "h2" }, "復習（×の次回）"),
      selectRow("意味 × の次回復習", "meaningXNext", [
        ["today", "当日（今）"],
        ["tomorrow", "翌日（+1日）"]
      ]),
      selectRow("綴り × の次回復習", "spellingXNext", [
        ["today", "当日（今）"],
        ["tomorrow", "翌日（+1日）"]
      ])
    ),
    el(
      "div",
      { class: "card stack" },
      el("div", { class: "h2" }, "データ管理"),
      el(
        "button",
        {
          class: "btn",
          onclick: async () => {
            const all = await getAllProgress();
            downloadJson("target1800-progress.json", { exportedAt: new Date().toISOString(), progress: all });
            toast("エクスポートしました");
          }
        },
        "学習データを書き出し（JSON）"
      ),
      el(
        "button",
        {
          class: "btn btnBad",
          onclick: async () => {
            if (!confirm("学習データを全削除します。よろしいですか？")) return;
            await clearAllData();
            ctx.progressById.clear();
            toast("削除しました");
            go("#/home");
          }
        },
        "学習データを全削除"
      ),
      el("div", { class: "help" }, "※個人情報は外部送信しません（端末内に保存されます）。")
    )
  );

  return layout("設定", card);
}

function notFoundScreen() {
  return layout(
    "ページが見つかりません",
    el(
      "div",
      { class: "card stack" },
      el("div", { class: "p" }, "URLが不正です。"),
      el("a", { class: "btn btnPrimary", href: "#/home" }, "ホームへ")
    )
  );
}

let ctxCache = null;
let sync = null;
let profilesState = null;

let profileSelectBusy = false;
function renderHeaderProfileSwitcher() {
  const sel = qs("#profileSelect");
  if (!sel) return;
  const st = profilesState || loadProfiles();
  const profiles = st.profiles || [];

  profileSelectBusy = true;
  sel.innerHTML = "";
  for (const p of profiles) {
    sel.appendChild(el("option", { value: p.id, selected: p.id === st.currentId ? "selected" : null }, p.name));
  }
  sel.appendChild(el("option", { value: "__add__" }, "＋ユーザー追加…"));
  sel.appendChild(el("option", { value: "__manage__" }, "設定で管理…"));
  profileSelectBusy = false;
}

async function switchProfile(profileId) {
  profilesState = setCurrentProfileId(loadProfiles(), profileId);
  setActiveProfileId(profileId);
  ctxCache = null;
  toast("ユーザーを切り替えました");
  renderHeaderProfileSwitcher();
  await render();
}

async function addProfileFromHeader() {
  const name = prompt("追加するユーザー名（例：太郎）");
  if (name === null) return;
  profilesState = addProfile(loadProfiles(), name);
  setActiveProfileId(profilesState.currentId);
  const key = prompt("このユーザーの合言葉（端末間同期用。空なら後で設定）");
  if (key !== null && String(key).trim()) {
    await setSetting("syncKey", String(key).trim());
  }
  ctxCache = null;
  toast("ユーザーを追加しました");
  renderHeaderProfileSwitcher();
  await render();
}

function attachHeaderProfileEvents() {
  const sel = qs("#profileSelect");
  if (!sel || sel.dataset.bound === "1") return;
  sel.dataset.bound = "1";
  sel.addEventListener("change", async () => {
    if (profileSelectBusy) return;
    const v = sel.value;
    if (v === "__add__") {
      await addProfileFromHeader();
      return;
    }
    if (v === "__manage__") {
      go("#/settings");
      return;
    }
    await switchProfile(v);
  });
}

function attachHeaderMenuEvents() {
  const btn = qs("#menuToggle");
  const links = qs("#navLinks");
  if (!btn || !links || btn.dataset.bound === "1") return;
  btn.dataset.bound = "1";

  const close = () => {
    links.classList.remove("open");
    btn.setAttribute("aria-expanded", "false");
  };
  const toggle = () => {
    const isOpen = links.classList.toggle("open");
    btn.setAttribute("aria-expanded", isOpen ? "true" : "false");
  };

  btn.addEventListener("click", (e) => {
    e.preventDefault();
    toggle();
  });

  // リンクを押したら閉じる
  links.addEventListener("click", (e) => {
    const a = e.target?.closest?.("a");
    if (a) close();
  });

  // 外側クリックで閉じる
  document.addEventListener("click", (e) => {
    if (!links.classList.contains("open")) return;
    const t = e.target;
    if (t === btn || btn.contains(t) || links.contains(t)) return;
    close();
  });

  // 画面遷移でも閉じる
  window.addEventListener("hashchange", close);
}

async function render() {
  try {
    if (!ctxCache) {
      setMain(layout("読み込み中…", el("div", { class: "card stack" }, el("div", { class: "p" }, "初回は少し時間がかかることがあります。"))));
      if (!profilesState) {
        profilesState = loadProfiles();
        setActiveProfileId(profilesState.currentId);
      }
      ctxCache = await loadAppContext();
      // HOME用の履歴（連続日数/XP計算）。重すぎないように最新200件だけ読む
      try {
        ctxCache._homeHistory = await getRecentHistory(200);
      } catch {
        ctxCache._homeHistory = [];
      }
      sync = createSyncManager({
        getSettings: () => ctxCache?.settings,
        setSettingValue: async (k, v) => {
          if (!ctxCache?.settings) return;
          ctxCache.settings[k] = v;
          await setSetting(k, v);
        },
        toast
      });
      attachHeaderProfileEvents();
      attachHeaderMenuEvents();
      renderHeaderProfileSwitcher();
    }
    const ctx = ctxCache;
    const route = parseHash();

    if (route.path === "/home") return void setMain(homeScreen(ctx));
    if (route.path === "/history") return void setMain(await historyScreen());
    if (route.path === "/analysis") return void setMain(analysisScreen(ctx));
    if (route.path === "/settings") return void setMain(settingsScreen(ctx));

    if (route.path === "/setup") {
      const mode = route.query.mode || "learn";
      return void setMain(setupScreen(ctx, mode));
    }
    if (route.path === "/learn") return void setMain(await learnScreen(ctx));
    if (route.path === "/test-meaning") return void setMain(await meaningTestScreen(ctx));
    if (route.path === "/test-spelling") return void setMain(await spellingTestScreen(ctx));

    return void setMain(notFoundScreen());
  } catch (e) {
    setMain(errorCard("アプリの初期化に失敗しました。", e?.stack || e?.message || String(e)));
  }
}

async function main() {
  // Service Worker
  if ("serviceWorker" in navigator) {
    try {
      await navigator.serviceWorker.register("./sw.js");
    } catch {
      // ignore
    }
  }

  onRouteChange(render);
  if (!window.location.hash) window.location.hash = "#/home";
  // ヘッダーのユーザー切替を先に初期化
  profilesState = loadProfiles();
  setActiveProfileId(profilesState.currentId);
  attachHeaderProfileEvents();
  attachHeaderMenuEvents();
  renderHeaderProfileSwitcher();
  await render();
  praiseOpen();

  // Keyboard shortcuts
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") go("#/home");
  });

  // Enter to submit in spelling
  window.addEventListener("keydown", (e) => {
    const route = parseHash();
    if (route.path !== "/test-spelling") return;
    const input = qs("#spell");
    const btn = [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("判定する"));
    if (e.key === "Enter" && input && document.activeElement === input && btn && !btn.disabled) {
      e.preventDefault();
      btn.click();
    }
  });
}

main();


