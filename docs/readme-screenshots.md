# Web Chatのスクリーンショット / Web Chat screenshots

日英READMEのPC画像と使い方ガイドのモバイル画像は、実際のWeb Chatに架空の会話・履歴・返信候補を渡して撮影しています。AIの実行結果ではありません。

The desktop images in the Japanese and English READMEs and the mobile images in the usage guides use the real Web Chat UI with fictional messages, conversation history, and reply suggestions. They are not actual AI output.

## 再撮影 / Capture

Node.js 22以降と既存のChromiumを使います。repoのlockfileに沿って依存を準備し、repoのルートで実行します。追加のnpm依存は不要です。

Use Node.js 22+ and an existing Chromium installation. Install dependencies from the lockfile and run from the repository root. No extra npm dependencies are required.

```bash
npm ci
node scripts/readme-screenshots.mjs
```

Chromiumの既定パスは`/snap/bin/chromium`です。別の場所なら次のように指定します。

The default Chromium path is `/snap/bin/chromium`. Override it if necessary:

```bash
XANGI_TEST_CHROMIUM=/path/to/chromium node scripts/readme-screenshots.mjs
```

- `docs/images/chat-desktop.png`: 1440 × 960 px（READMEでは幅640で表示 / displayed at width 640 in the READMEs）
- `docs/images/chat-mobile.png`: 390 × 844 px（Chromiumのモバイル表示 / Chromium mobile emulation）

スクリプトはloopbackの一時Viteサーバーと使い捨てブラウザプロファイルを使います。APIはメモリ内のダミー応答で、xangi本体・AI・外部サービスを起動・接続しません。日時・テーマは固定し、外部リクエストは遮断します。未知のAPI呼び出し、ブラウザ例外、画面幅のはみ出しを検出すると失敗します。終了時に一時サーバー・ブラウザを停止し、プロファイルを削除します。

The script uses a temporary loopback Vite server and a disposable browser profile. APIs return in-memory fixtures; no xangi runtime, AI, or external service is started or connected. Time and theme are fixed, and external requests are blocked. Unknown API calls, browser exceptions, and horizontal viewport overflow fail the capture. The temporary server and browser are stopped and the profile is removed on exit.
