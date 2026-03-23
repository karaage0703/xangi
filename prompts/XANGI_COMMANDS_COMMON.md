# XANGI_COMMANDS_COMMON.md - xangi専用ガイド（共通）

xangiの専用コマンド・設定・運用ルール。
**セッション開始時に必ず読むこと。**

## 記述ルール（全コマンド共通）

- **行頭に書くこと** — `!discord`, `!schedule`, `SYSTEM_COMMAND:` は行頭に記述する必要がある
- `MEDIA:` は行中のどこに書いてもOK
- **コードブロック内は無視される** — ` ``` ` で囲んだ中のコマンドは実行されない（ドキュメント例示に安全に使える）

## システムコマンド

応答に以下の形式を含めることで、システムを操作できる（行頭に記述）：

- `SYSTEM_COMMAND:restart` — ボットを再起動
- `SYSTEM_COMMAND:set autoRestart=true` — 自動再起動を有効化
- `SYSTEM_COMMAND:set autoRestart=false` — 自動再起動を無効化

ユーザーから再起動を求められた場合は `SYSTEM_COMMAND:restart` を含める。
スラッシュコマンド `/restart` `/settings` もある。


## スケジュール・リマインダー

`!schedule` コマンドでリマインダーや定期実行を設定できる。

### 設定ファイル

`.xangi/schedules.json` に保存される。手動で編集も可能。

### コマンド

```
!schedule add <設定>     # スケジュール追加
!schedule list           # 一覧表示
!schedule remove <ID>    # 削除
!schedule toggle <ID>    # 有効/無効切り替え
```

### 設定フォーマット

- `30分後 ミーティング` — N分後（秒/時間も可）
- `15:00 レビュー` — 今日のその時刻（過ぎたら翌日）
- `2025-03-01 14:00 締め切り` — 日時指定
- `毎日 9:00 おはよう` — 毎日定時
- `毎時 チェック` — 毎時0分
- `毎週月曜 10:00 週次MTG` — 毎週（月〜日対応）
- `cron 0 9 * * * おはよう` — cron式直接指定

## チャンネルモデル設定（スラッシュコマンド）

`/model` コマンドで、チャンネルごとに異なる AI モデルと thinking effort を設定できる。

### コマンド

- `/model set <model> [effort]` — このチャンネルのモデル（+ effort）を設定
- `/model show` — このチャンネルの現在の設定を表示
- `/model reset` — このチャンネルの設定をデフォルトに戻す
- `/model list` — 全チャンネルの設定一覧を表示

### モデル名

- `sonnet` — Claude Sonnet
- `opus` — Claude Opus
- `haiku` — Claude Haiku

### effort（Opus のみ）

- `low` / `medium` / `high`
- effort は Opus 系モデルでのみ有効。Sonnet / Haiku では使用不可。

### 設定ファイル

`.xangi/channel-models.json` に永続化される。サービス再起動後も設定は維持される。

---

## タイムアウト対策

xangiのタイムアウトは環境設定による（デフォルト値はサービス設定に依存）。
長時間かかる処理はバックグラウンド実行し、即座に「実行開始した」と応答を返すこと。

### `nohup` vs `run_in_background` の使い分け

- **`nohup コマンド > log 2>&1 &`（推奨）** — Claude Codeプロセスが終了しても処理が継続する。タイムアウトやセッション切れでも安全
- **`run_in_background: true`** — Claude Codeプロセス内で動くため、タイムアウトでプロセスごとkillされると一緒に死ぬ

**結論：長時間処理は `nohup` を使うこと。** `run_in_background` はプロセスが生きている間だけの短いバックグラウンド処理向け。

```bash
# 長時間処理の例
nohup 長いコマンド > /tmp/output.log 2>&1 &
echo "PID: $!"
```

結果は次回のやり取り時に `tail /tmp/output.log` で確認して報告する。

### 必ずバックグラウンド実行する処理
- 文字起こし
- 大規模ビルド
- 長時間のダウンロード
