import { el, qs } from "./ui.js";

const IMAGES = {
  normal: "./assets/chara/image_1.png",
  doya: "./assets/chara/image_2.png",
  super: "./assets/chara/image_3.png",
  surprise: "./assets/chara/image_4.png",
  trouble: "./assets/chara/image_5.png",
  cheer: "./assets/chara/image_6.png",
  guts: "./assets/chara/image_7.png",
  shy: "./assets/chara/image_8.png"
};

// ユーザー提供のセリフ
const LINES = {
  normal: [
    "よし！英単語の時間だな！",
    "アタイについてこい！",
    "今日はどこまでいく？",
    "サボってないよな？",
    "英語くらい余裕だろ！",
    "準備いいかー？",
    "最強目指すぞ！"
  ],
  cheer: ["よし一気にいくぞ！", "アタイがついてる！", "ここからが本番！", "10問だけやろうぜ！", "今日も強くなるぞ！", "いいペースだ！", "止まるなよー！"],
  doya: ["やるじゃん！", "当然だよな！", "アタイの弟子だな！", "今の完璧！", "見直したぞ！", "その調子その調子！", "もう覚えたな！"],
  super: ["最強じゃん！！", "天才かよ！", "氷の天才誕生！", "アタイ超えたな！？", "全部覚えてんじゃん！", "ノってきたな！", "このまま全部いくぞ！"],
  surprise: ["えっ、今のわかったの！？", "やるじゃん…！", "ちょっと本気出してきた？", "すごくないか！？", "今のはアタイでも驚いた！", "急に強くなってない？"],
  trouble: ["今のは忘れてただけだよな！", "まあ次だ次！", "まだ覚え途中だな！", "ここ弱点だぞ！", "よし、もう1回！", "今ので覚えたろ！", "あとで復習な！"],
  guts: ["勝ったな！", "完全に覚えた！", "弱点つぶしたな！", "いいぞいいぞ！", "完璧だ！", "最強に近づいた！", "この調子で全部いくぞ！"],
  shy: ["…ちょっと見直した", "がんばったじゃん", "今日はここまででいいぞ", "ちゃんとやるじゃん", "えらいえらい", "また明日な！", "べ、別に嬉しくないけど！"]
};

function randPickNoRepeat(arr, last) {
  if (!arr || arr.length === 0) return "";
  if (arr.length === 1) return arr[0];
  let x = arr[Math.floor(Math.random() * arr.length)];
  if (x === last) {
    x = arr[(arr.indexOf(x) + 1) % arr.length];
  }
  return x;
}

export function createChirnoController({ getSettings }) {
  const root = qs("#chirnoRoot");
  const img = qs("#chirnoImg");
  const bubble = qs("#chirnoBubble");
  if (!root || !img || !bubble) {
    return {
      set: () => {},
      say: () => {},
      setEnabled: () => {}
    };
  }

  let lastAt = 0;
  let lastLineByCategory = {};
  let pending = null;
  let timer = null;
  let hideTimer = null;

  function enabled() {
    return !!getSettings()?.chirnoEnabled;
  }

  function setEnabled(on) {
    root.style.display = on ? "block" : "none";
  }

  function set(emotionKey) {
    if (!enabled()) return;
    const src = IMAGES[emotionKey] || IMAGES.normal;
    img.src = src;
  }

  function showBubble(text) {
    bubble.innerHTML = "";
    bubble.appendChild(el("div", { class: "chirnoBubble__text" }, text));
    bubble.classList.add("show");
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => bubble.classList.remove("show"), 3000);
  }

  function run(category, emotionKey) {
    if (!enabled()) return;
    setEnabled(true);
    set(emotionKey);
    // ぷるっと跳ねる（セリフ発生時）
    try {
      img.classList.remove("bounce");
      // reflow
      void img.offsetWidth;
      img.classList.add("bounce");
    } catch {
      // ignore
    }
    const last = lastLineByCategory[category] || "";
    const line = randPickNoRepeat(LINES[category] || LINES.normal, last);
    lastLineByCategory[category] = line;
    showBubble(line);
  }

  function flushPending() {
    if (!pending) return;
    const p = pending;
    pending = null;
    lastAt = Date.now();
    run(p.category, p.emotionKey);
  }

  function say(category, { emotionKey } = {}) {
    if (!enabled()) return;
    const now = Date.now();
    const minInterval = 1500;
    const ek = emotionKey || category || "normal";

    // 連発防止：短時間なら「最後の1件だけ」残す
    if (now - lastAt < minInterval) {
      pending = { category, emotionKey: ek };
      if (timer) clearTimeout(timer);
      timer = setTimeout(flushPending, minInterval - (now - lastAt) + 10);
      return;
    }
    lastAt = now;
    run(category, ek);
  }

  // 初期：通常で待機（セリフは出さない）
  setEnabled(enabled());
  set("normal");
  // 常時は小さくふわふわ（邪魔にならない程度）
  try {
    img.classList.add("bounceSoft");
  } catch {
    // ignore
  }

  return { set, say, setEnabled };
}


