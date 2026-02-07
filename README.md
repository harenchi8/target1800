
⸻

英単語学習アプリ 仕様書（中学生向け / PWA対応）

1. 目的
	•	中学生が英単語を「意味」と「綴り（スペル）」の両面で定着できる学習アプリを提供する。
	•	学習は 想起（思い出して書く） を中心に設計する。
	•	PWAとしてインストール可能・オフラインでも利用可能。
	•	学習記録を端末内に保存し、苦手分析・復習最適化（SRS）に活用する。

⸻

2. 対象データ

2.1 入力データ（JSON）
	•	ファイル：target1800.min.json（1800件）
	•	形式（1件）：

{
  "id": 1,
  "word": "the",
  "phonetic": "[ðə / ði]",
  "eiken": "英検5級",
  "level": "LEVEL1",
  "meaning_ja": "その",
  "example_en": "Put the box by the door, please.",
  "example_ja": "その箱はそのドアのそばに置いてください",
  "notes": "【用法】...",
  "source": null
}

2.2 表示ルール
	•	meaning_ja / notes に含まれる \n は改行として表示。
	•	例文は「学習カード」では常に表示可能、テスト中は設定により表示可否を切替。

⸻

3. 学習機能（モード）

3.1 覚える（インプット）
	•	単語カードを順に閲覧するモード。
	•	表示：
	•	単語 / 発音記号 / 意味 / 例文（英・日）/ 用法・特記事項 / レベル
	•	操作：
	•	前へ/次へ
	•	お気に入り（任意）
	•	「覚えた」チェック（任意：進捗表示に使用）
	•	このモードでは正誤記録は必須ではない（任意）。

⸻

3.2 テスト：意味（メイン）

3.2.1 出題
	•	問題提示：word（英単語）
	•	ユーザー回答：日本語で意味を自由入力（必須）
	•	「答えを見る」ボタン押下で正解を表示する

3.2.2 正解表示
	•	meaning_ja
	•	example_en / example_ja（設定でON/OFF、ただし推奨ON）
	•	notes（設定でON/OFF、ただし推奨ON）

3.2.3 採点（自己採点：3択）

ユーザーが ○ / △ / × を選択して確定する。
	•	○：ほぼ正しく意味を書けた
	•	△：近いがあいまい／一部不足
	•	×：思い出せない／間違い

※採点ボタンは「正解表示の後」にのみ押せる。

⸻

3.3 テスト：綴り（スペル）

3.3.1 出題

出題形式は設定で選択可能：
	•	A) 日本語の意味（meaning_ja）を見て英単語を入力（推奨）
	•	B) 英例文の穴埋め（example_en内の対象語を空欄化）※後回しでもOK

3.3.2 回答
	•	英単語をキーボード入力
	•	判定：完全一致（小文字化・前後空白除去）
	•	採点：自動判定で○/×（綴りは客観採点）

⸻

3.4 間違えた単語集中（復習）
	•	条件で抽出して復習セットを生成：
	•	意味×（meaning）だけ
	•	綴り×（spelling）だけ
	•	両方×
	•	△含む（任意でON）
	•	出題：原則入力式（甘くしない）
	•	目標：「連続○」で復習卒業（例：意味は○が2連続で復習間隔を伸ばす）

⸻

4. 出題セット生成（問題の作り方）

ユーザーが以下を選んでセッションを作成できる。

4.1 フィルタ
	•	レベル：LEVEL1〜（複数選択）
	•	英検：英検5級〜（任意）

4.2 出題順
	•	完全ランダム
	•	苦手優先（間違い・△が多い順）
	•	未学習優先（履歴なし or 学習回数少）
	•	復習優先（nextReviewAtが近い順）

4.3 問題数
	•	10 / 20 / 50 / 任意入力

4.4 回答形式（意味）
	•	自由入力（固定）
	•	正解表示時に例文・用法を出す：ON/OFF
	•	採点：○/△/×（固定）

⸻

5. 学習記録（端末内保存）

PWAオフライン前提のため、保存は IndexedDB 推奨（localStorageでも試作可）。

5.1 保存対象（最小）

WordProgress（単語ごとの進捗）

キー：wordId（= JSONのid）
	•	meaning:
	•	meaningCorrect (int)
	•	meaningPartial (int)  // △
	•	meaningWrong (int)
	•	meaningStreak (int)   // ○連続
	•	meaningLastAt (ISO string)
	•	meaningNextReviewAt (ISO string)
	•	spelling:
	•	spellingCorrect (int)
	•	spellingWrong (int)
	•	spellingStreak (int)
	•	spellingLastAt
	•	spellingNextReviewAt
	•	spellingHintUsed (int) ※ヒント実装時
	•	flags:
	•	isFavorite (bool)
	•	isLearned (bool) ※「覚えた」チェック

SessionResult（任意：分析を強くしたい場合）
	•	timestamp
	•	wordId
	•	type: "meaning" | "spelling"
	•	grade: "o" | "triangle" | "x"（意味） / "o" | "x"（綴り）
	•	inputText（任意：保存するなら個人情報注意・端末内のみ）

⸻

6. 復習アルゴリズム（SRS）

※シンプルで実装しやすい固定テーブル方式（初期版）

6.1 間隔テーブル（意味：○）
	•	streak 0→1：+1日
	•	streak 1→2：+3日
	•	streak 2→3：+7日
	•	streak 3→4：+14日
	•	streak 4以降：+30日（上限）

6.2 採点別の処理（意味）
	•	○：
	•	meaningStreak += 1
	•	meaningNextReviewAt = now + intervalByStreak
	•	meaningCorrect += 1
	•	△：
	•	meaningStreak = 0
	•	meaningNextReviewAt = now + 1〜2日（固定：+1日推奨）
	•	meaningPartial += 1
	•	×：
	•	meaningStreak = 0
	•	meaningNextReviewAt = now（当日）or +1日（設定/時間帯で決定）
	•	meaningWrong += 1

6.3 綴り（スペル）
	•	○：spellingStreak += 1、間隔は意味と同じテーブル適用
	•	×：spellingStreak = 0、nextReviewAt = now or +1日、wrong++

⸻

7. 分析（表示機能）

7.1 苦手一覧
	•	苦手単語TOP（意味 / 綴り別）
	•	スコア例：wrong*3 + partial*2 - correct など
	•	LEVEL別正答率（意味・綴り別）
	•	今日の復習予定件数（meaningNextReviewAt / spellingNextReviewAt が now 以前）

7.2 可視化（任意）
	•	7日間の学習数、正答率推移
	•	連続学習日数（継続モチベ）

⸻

8. 画面一覧（最低限）
	1.	ホーム
	•	今日の復習（件数）
	•	覚える / テスト（意味）/ テスト（綴り）/ 間違い集中 / 分析 / 設定
	2.	出題作成（セッション設定）
	3.	覚える（カード）
	4.	テスト（意味）：入力 → 正解表示 → ○/△/×
	5.	テスト（綴り）：入力 → 判定 → 次へ
	6.	間違い集中：フィルタ → セッション
	7.	分析：苦手一覧・レベル別
	8.	設定：表示・保存・データ管理

⸻

9. PWA要件
	•	manifest.json：アプリアイコン、name/short_name、display=standalone
	•	Service Worker：
	•	App Shell（HTML/CSS/JS）をキャッシュ
	•	target1800.min.json を初回取得してキャッシュ（オフライン読込可）
	•	キャッシュ戦略：
	•	App Shell：Cache First
	•	JSON：Cache First（更新があるならバージョンキーで更新）

⸻

10. 非機能要件
	•	オフライン動作（学習・記録・分析が端末内で完結）
	•	データは外部送信しない（個人情報扱いを避ける）
	•	レスポンス：1画面操作が体感遅延なく動く（1800語規模なら余裕）
	•	アクセシビリティ：
	•	ボタンは十分なタップ領域
	•	キーボード操作（入力→確定→次へ）
	•	コントラスト確保（最低限）

⸻

11. 実装のおすすめ技術（例）
	•	フレームワーク：React / Vue / Svelte / Vanilla いずれも可
	•	保存：IndexedDB（Dexie.jsなど採用可）
	•	ルーティング：SPA + PWA
	•	音声（任意）：Web Speech API（発音） ※後回しでOK

⸻

12. MVP（最初に作る最小機能）

これだけで成立する最短構成：
	•	JSON読込（1800語）
	•	覚える（カード）
	•	テスト（意味：自由入力→正解表示→○/△/×→記録→SRS）
	•	間違い集中（×/△抽出）
	•	分析（苦手TOPとLEVEL別）
	•	PWA（オフラインでJSON読める）

⸻

13. 今後の拡張（優先順位案）
	1.	綴りの「例文穴埋め」
	2.	スペルの誤り位置ハイライト
	3.	音声（単語/例文読み上げ）
	4.	学習目標・連続学習などのゲーミフィケーション
	5.	データエクスポート（学習ログJSON/CSV）

⸻

## 実装（このリポジトリに追加したもの）

この仕様書に沿って、依存なし（ビルド不要）の静的PWAとしてMVPを実装しています。

### ファイル構成（主要）

- `index.html`: SPA本体
- `styles.css`: UI
- `src/`: ロジック（ルーティング / IndexedDB / SRS / 画面）
- `data/target1800.min.json`: 単語データ（現在はサンプル3件。実データで置き換えてください）
- `manifest.json` / `sw.js`: PWA（オフライン対応）

### 起動方法（ローカル）

Service Worker を使うため、HTTPサーバーで開いてください（`file://` 直開きは不可）。

例（macOS / Python）：

```bash
python3 -m http.server 5173
```

ブラウザで `http://localhost:5173` を開きます。

### GitHub Pagesで公開する（PWAとして配布）

このリポジトリは **静的ファイルのみ** なので、GitHub Pagesにそのまま載せられます。

1) GitHubにリポジトリ作成 → このフォルダをpush  
2) GitHubのリポジトリ設定 → **Settings → Pages**  
3) **Build and deployment**  
- Source: **Deploy from a branch**  
- Branch: **main / (root)**（または `master`）  
4) 数十秒待つと `https://<user>.github.io/<repo>/` が発行されます

#### PWAとしてインストール（例）

- **Android/Chrome**: URLを開く → メニュー →「**アプリをインストール**」  
- **iOS/Safari**: URLを開く → 共有 →「**ホーム画面に追加**」

#### 注意（アイコン）

現在の `manifest.json` はSVGアイコンのみです。Android/デスクトップは概ねOKですが、端末/ブラウザによっては **PNG(192/512)** を推奨します（必要なら追加します）。

