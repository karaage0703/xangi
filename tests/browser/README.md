# プロジェクト・エージェント画面の回帰確認

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
