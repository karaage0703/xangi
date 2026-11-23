# プロジェクト・エージェント画面の回帰確認

ファイル一覧の並び替えは `npm run build:web` 後に `uv run --with playwright python tests/browser/workspace-sort.py` で検証します。390/820/1280pxで名前・更新日時の昇順／降順、タグ絞り込み、フォーカス移動先がnullのケース、外側タップ・Escape・Tabによるメニュー操作を確認します。nullのフォーカス移動は明示的に再現するため、iOS実機確認の代替にはなりません。`BROWSER_ENGINE=webkit` でWebKitを選択でき、`BROWSER_TEST_OUTPUT` で画像保存先を指定できます。

ビルドした画面を隔離Chromiumと模擬APIで検証します。実環境の設定は変更しません。

```sh
npm run build
uv run --with playwright python tests/browser/catalog_forms.py
```

実行環境には `/snap/bin/chromium` が必要です。証跡の保存先は実行時に表示されます。

1280/768/390/320pxで、作成・編集・再読み込み、workspace/Local LLM設定の保存、旧Avatar名前による非表示の廃止、フォーム内検索欄の非表示、一覧の検索条件に影響されない参加者選択を確認します。

設定画面の段階表示と接続確認失敗後の再読み込みは、同じ隔離環境で次のコマンドにより確認します。認証APIを保留したまま通常設定の表示・保存を1280/390pxで検証します。

```sh
uv run --with playwright python tests/browser/settings_loading.py
```

担当一覧・担当指定での新会話・チャンネル担当の保存/解除・処理中拒否は `uv run --with playwright python tests/browser/agent_selection.py` で1280/768/414/375/320pxを確認します。

`uv run --with playwright python tests/browser/channel_settings.py` は、Discord/Slackのチャンネル設定でワークスペースの選択・保存・再読込・継承へのリセット・保存失敗後の再試行・担当エージェント優先・機能無効時の編集禁止を1280/390pxで確認します。キーボード選択、長いパスの折返し、モデル設定の回帰も検証します。

Team作成・3階層の報告先・編集/再読込・チャンネル割当/解除・削除・処理中拒否は `uv run --with playwright python tests/browser/team_settings.py` で1280/768/414/375/320pxを確認します。

チャットのプロジェクト一覧・設定導線は `uv run --with playwright python tests/browser/chat_sidebar_projects.py` で確認します（Playwright同梱Chromiumを使用）。1280/768/375/320pxで選択・新規作成・名前/指示の保存・失敗後再試行・再読込・キャンセル・全体設定への移動を検証し、0件/100件の一覧とキーボード操作も確認します。`BROWSER_TEST_OUTPUT` で画像の保存先を指定できます。

`uv run --with playwright python tests/browser/chat-sidebar-attachments.py` は、build後に1280/390/320pxで会話行の密度、44pxのタップ領域、Discord/Slack接続Projectの既存/新規会話での添付送信・失敗後の再試行を隔離APIで確認します。`BROWSER_TEST_OUTPUT` で画像の保存先を指定できます。

同じ添付検証は、受付前エラーからの再試行、受付後の再読込、受付応答欠落からの照会復帰、元チャットへの結果だけの再投稿、操作アイコンの右寄せも確認します。本文と写真が入力欄へ戻らず、同じ受付IDでAIを二重実行しない経路を模擬APIで再現します。

チャットの幅調整は `uv run --with playwright python tests/browser/chat-sidebar-resize.py` で検証します。build後、ドラッグ・再読込・矢印キー・上下限・キャンセル・標準幅への復帰・開閉・モバイル表示・保存値不正／保存不可を隔離APIで確認します。`BROWSER_TEST_OUTPUT` で画像の保存先を指定できます。

専用Bot接続は `uv run --with playwright python tests/browser/agent_connections.py` で検証します。build後、1280/390/320pxでDiscord・Slack接続の追加、保存失敗後の再試行、再読み込み、トークンの非表示、編集・無効化・削除・キャンセルを模擬APIで確認します。`BROWSER_TEST_OUTPUT` で証拠保存先を指定できます。実Botへの接続は行いません。


Chatの初回表示と更新通知、Monitorの差分通知は、ビルド後に隔離Chromiumと模擬APIで確認できます。初回はキャッシュを無効にして、入力欄・一覧の描画時刻、読み込んだJavaScriptのサイズと一覧GET回数を記録します。SSEの初回受信がない場合のREST取得、会話検索、Markdown添付の表示も確認します。

```sh
npm run build:web
XANGI_PERF_PRODUCTION=1 XANGI_ASSERT_PERF=1 node tests/browser/web-performance.mjs /tmp/xangi-web-perf
```

`XANGI_PERF_STARTUP_SAMPLES` で初回表示の測定回数を指定できます。変更前の配布物で比較する際は `XANGI_PERF_WEB_BUILD` にその `web/app` を指定し、`XANGI_ASSERT_PERF` を外します。
