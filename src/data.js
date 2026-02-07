let cached = null;

export async function loadWords() {
  if (cached) return cached;
  const res = await fetch("./data/target1800.min.json", { cache: "no-cache" });
  if (!res.ok) throw new Error(`単語JSONの取得に失敗しました: ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error("JSON形式が不正です（配列ではありません）");

  const words = data
    .filter((w) => w && typeof w.id === "number" && typeof w.word === "string")
    .map((w) => ({
      id: w.id,
      word: String(w.word),
      phonetic: w.phonetic ? String(w.phonetic) : "",
      eiken: w.eiken ? String(w.eiken) : "",
      level: w.level ? String(w.level) : "",
      meaning_ja: w.meaning_ja ? String(w.meaning_ja) : "",
      example_en: w.example_en ? String(w.example_en) : "",
      example_ja: w.example_ja ? String(w.example_ja) : "",
      notes: w.notes ? String(w.notes) : "",
      source: w.source ?? null
    }))
    .sort((a, b) => a.id - b.id);

  const levels = [...new Set(words.map((w) => w.level).filter(Boolean))];
  const eikens = [...new Set(words.map((w) => w.eiken).filter(Boolean))];
  cached = { words, levels, eikens };
  return cached;
}


