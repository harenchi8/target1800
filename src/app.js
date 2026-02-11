import { loadWords } from "./data.js";
import { clearAllData, createEmptyProgress, deleteProfileDb, getAllProgress, getAllSettings, getProgress, getProgressMap, putProgress, setActiveProfileId, setSetting } from "./db.js";
import { parseHash, onRouteChange, go } from "./router.js";
import { clamp, el, fmtDateTime, qs, setMain, toast } from "./ui.js";
import { applyMeaningGrade, applySpellingGrade, scoreMeaning, scoreSpelling } from "./srs.js";
import { buildCandidateWords, buildReviewCandidates, mergeSettings, normalizeWord, orderWords, summarizeDue } from "./logic.js";
import { createSyncManager, isSyncConfigured } from "./sync.js";
import { addProfile, loadProfiles, removeProfile, setCurrentProfileId } from "./profiles.js";

const SESSION_KEY = "t1800_session_v1";

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
  const due = summarizeDue([...ctx.progressById.values()]);

  const btnRow = el(
    "div",
    { class: "grid2" },
    el(
      "a",
      { class: "btn btnPrimary", href: "#/setup?mode=learn" },
      "覚える（カード）"
    ),
    el(
      "a",
      { class: "btn btnPrimary", href: "#/setup?mode=meaning" },
      "テスト（意味）"
    ),
    el(
      "a",
      { class: "btn btnPrimary", href: "#/setup?mode=spelling" },
      "テスト（綴り）"
    ),
    el(
      "a",
      { class: "btn btnPrimary", href: "#/setup?mode=review" },
      "間違い集中（復習）"
    )
  );

  const meta = el(
    "div",
    { class: "row" },
    el("span", { class: "pill" }, `単語数: ${ctx.words.length}`),
    el("span", { class: "pill" }, `今日の復習（意味）: ${due.meaningDue}`),
    el("span", { class: "pill" }, `今日の復習（綴り）: ${due.spellingDue}`)
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
    el("div", { class: "p" }, "「綴り」は完全一致（小文字化・前後空白除去）で自動判定です。"),
    el(
      "div",
      { class: "help" },
      "※ data/target1800.min.json はサンプル3件です。実データを置き換えると1800語で動きます。"
    )
  );

  return layout("ホーム", el("div", { class: "stack" }, meta, btnRow, help));
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
    showResult(isCorrect);
  });

  nextBtn.addEventListener("click", () => {
    session.idx = clamp(idx + 1, 0, session.wordIds.length - 1);
    session.spellingChecked = false;
    session.spellingWasCorrect = null;
    saveSession(session);
    if (idx + 1 >= session.wordIds.length) {
      toast("セッション完了");
      clearSession();
      sync?.schedulePush("after-session-end");
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
    const input = el("input", { type: "password", value: s[key] || "", placeholder });
    input.addEventListener("change", async () => {
      s[key] = input.value;
      await setSetting(key, s[key]);
      toast("設定を保存しました");
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
              ctxCache = null;
              toast("ユーザーを追加しました。合言葉を設定してください。");
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
      passwordRow("合言葉", "syncKey", "この端末に保存されます"),
      toggleRow("学習の区切りで自動同期する（おすすめ）", "syncAuto"),
      el(
        "div",
        { class: "row" },
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
                const msg = e?.message || String(e);
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
                const msg = e?.message || String(e);
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
async function render() {
  try {
    if (!ctxCache) {
      setMain(layout("読み込み中…", el("div", { class: "card stack" }, el("div", { class: "p" }, "初回は少し時間がかかることがあります。"))));
      profilesState = loadProfiles();
      setActiveProfileId(profilesState.currentId);
      ctxCache = await loadAppContext();
      sync = createSyncManager({
        getSettings: () => ctxCache?.settings,
        setSettingValue: async (k, v) => {
          if (!ctxCache?.settings) return;
          ctxCache.settings[k] = v;
          await setSetting(k, v);
        },
        toast
      });
    }
    const ctx = ctxCache;
    const route = parseHash();

    if (route.path === "/home") return void setMain(homeScreen(ctx));
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
  await render();

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


