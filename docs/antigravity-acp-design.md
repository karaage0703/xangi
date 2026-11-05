# Antigravity ACP 調査と導入案

## 方針

2026-11-05時点では設計調査のみ。既存のJSON / stream-json方式を既定のまま維持し、ACPへの自動切り替えや新しい環境変数は追加しない。他バックエンド・Monitorのアカウント利用枠取得も変更しない。

## 確認できたこと

- [Agy 1.5.0リリース](https://github.com/google-antigravity/antigravity-cli/releases/tag/1.5.0)はACPのstdioサーバー、画像・埋め込みファイル文脈、実行中の追加指示、履歴再送なしの再開、会話別モデル・思考レベルを案内している。
- 公式macOS arm64配布の1.5.0固定バイナリで `acp --help` と `initialize` を確認した。セッション作成、モデル生成、権限要求、停止、再開は未検証。
- `initialize` の `protocolVersion` は `1`、`agentInfo.version` は `1.5.0`。`promptCapabilities` は `image: true`、`embeddedContext: true`、`audio: false`。
- `loadSession: true`、`sessionCapabilities` に `resume`、`close`、`load`、`list`、`additionalDirectories` があった。`_meta.antigravity.systemPrompt.append` もあるが、独自拡張の送信仕様は未検証。
- `acp --help` に `--process-per-session`、`--sandbox`、`--login` がある。モード・モデル・思考レベルの実際の選択肢は、セッション作成後の応答で検証する必要がある。
- 調査中に通常のインストールが1.5.1へ自動更新されたため、最終確認は別途取得した1.5.0固定バイナリで行った。バージョン比較だけで機能を決めず、毎起動の能力ネゴシエーションを使う。

## 実装する場合の境界

既存 `AntigravityRunner` を置換せず、独立したACP transport / runnerを明示オプトインで追加する案とする。共有するのは `AgentRunner`、既存のプロセス管理、タイムアウト、セッション・イベントAPIまで。JSON-RPCの実装は公式TypeScript SDKを評価し、手書きのRPC多重化は避ける。

| 項目             | 導入時の要件                                                                                                                                                              |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 起動・所有権     | まずcontext keyごとのプロセスに限定。workspace・プラットフォーム・トピックをまたいで共有しない。既存processManagerとtimeoutControllerに登録する                           |
| 初期化           | `initialize` でプロトコルと能力を確認。未広告のメソッドや入力形式は送らない。認証は事前の `agy acp --login` とし、チャット経由の自動ログインは行わない                    |
| 会話             | 新規は `session/new`。再開は広告された `session/resume` を優先し、必要なら `session/load` の履歴再送を新規回答として表示しない。失敗した会話IDを暗黙に新規bindingにしない |
| モード           | `ANTIGRAVITY_MODE` とsessionの広告モードを照合する。`plan`・`accept-edits`・`auto` を未確認の `default` に読み替えない。非対応は明示エラー                                |
| 権限             | `session/request_permission` は既存の管理者方針・承認UIに接続。実装前は拒否を既定とし、無応答にしない。`SKIP_PERMISSIONS` から危険な全許可フラグへ自動変換しない          |
| ファイル・ツール | xangiの検証済み保存先とworkspace境界を使用。filesystem / terminalのクライアント能力は、安全な実装が完了するまで広告しない。MCP接続と環境変数の最小化も既存の隔離を維持    |
| 表示             | agent messageだけを `onText` に流す。thinkingやtool結果・履歴再送は本文に混ぜない。tool callの開始・更新・終了は既存イベントへ変換する                                    |
| 停止・期限       | `/stop`・`/new`・期限で `session/cancel` を通知し、有限の待機後にプロセスを強制終了。キャンセル確認後の遅着イベントもgenerationで遮断。終了を成功や自動再試行に変換しない |
| 追加指示         | 初期段階は既存の1会話1実行キューを維持。実行中のsteeringは明示操作・別設計で追加し、一般の後続メッセージを勝手に割り込ませない                                            |
| 障害             | 途中回答を保持し未完了通知。`session/prompt`送信後の切断では、旧CLI方式への自動fallbackも再送もしない。認証・能力確認など依頼送信前の失敗だけ切り替えを検討できる         |
| 診断             | 生のRPC、認証情報、画像本体、thinkingを通常ログへ出さない。request ID・session ID・分類済み理由のみ必要範囲で保持                                                         |

## 導入手順と合格条件

1. オフラインRPC fixtureテストで、相関ID、分割受信、未知イベント、切断、バックプレッシャー、起動・停止期限を検証する。
2. 実機で `session/new`、通常ターン、モード・モデル変更、画像・埋め込み文脈、承認の許可/拒否、`session/cancel`、`session/resume` を検証する。認証済み実機・モデル利用は明示オプトインのintegration testに限定する。
3. Discord / Telegram / Webの停止・リセット、同時チャンネルの隔離、再起動、schedulerの再試行抑止を確認する。旧Agyでは従来方式を維持する。
4. 利用者が明示選択できる実験的transportとして提供し、既定変更は別PRで判断する。

`/usage` のアカウント枠取得は既存方式を維持する。ACP導入だけでheadless statuslineや会話別cost取得の問題が解決したとは扱わない。remote-agentはローカル添付・MCP・workspace境界が異なるため本設計の対象外。

## 仕様資料

- [ACP session setup](https://agentclientprotocol.com/protocol/v1/session-setup): 能力に応じた新規作成・再開・履歴再送の規約。
- [ACP公式ドキュメント](https://agentclientprotocol.com/): transport、permission、cancellationの実装時に参照する。

上記の導入要件はxangi側の提案であり、Agy 1.5.0で全経路を実証済みという意味ではない。
