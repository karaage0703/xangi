[English](en/inter-instance-chat.md) | 日本語

# inter-instance-chat — xangi インスタンス間連携

xangi の複数インスタンスが、Discord/Slackを介さず認証付きHTTPでタスクをやり取りする機能。
ユーザーが現在のxangiへ「`instance-b`に○○を聞いて」と頼むと、agentは
`inter_chat_ask`で宛先を指定し、回答を待って元の会話へ返す。

```text
ユーザー → instance-a → POST /api/inter-chat/ask → instance-b
                              Bearer token             ↓
ユーザー ← instance-a ←──────── HTTP応答 ───── 通常Web Session
                                                    （履歴・継続文脈）
```

同一マシン・別マシンの両方に対応する。別マシン間ではTailscale内での利用を推奨する。
同じxangiインスタンス内の担当に依頼するときは `xangi agent list` と `xangi agent run` を使う。既定の担当には `xangi agent run default --task "依頼と必要な背景"` を使う。`inter_chat_ask` の宛先は別インスタンスのIDであり、agent名ではない。

## 設定

```bash
INTER_INSTANCE_CHAT_ENABLED=true
INTER_INSTANCE_CHAT_TOKEN=<十分長い共通秘密値>
INTER_INSTANCE_CHAT_PEERS='{"instance-a":"http://100.64.0.1:18888","instance-b":"http://100.64.0.2:18888"}'
INTER_INSTANCE_CHAT_ALLOWED_PEERS=instance-a,instance-b
WEB_CHAT_HOST=100.64.0.2
XANGI_INSTANCE_ID=my-instance
XANGI_INSTANCE_LABEL=my-instance
```

`INTER_INSTANCE_CHAT_ALLOWED_PEERS`は受信元instance IDのallowlist。未設定または`*`は、
正しいBearer tokenを持つ全instanceを許可する。

## 指名問い合わせ

通常のDiscord / Slack / Web Chatで「instance-bに現在の状態を聞いて」のように依頼する。
共通プロンプトがこの表現を検出し、Tool Server経由で次を実行する。

```bash
xangi tool inter_chat_ask --to instance-b --text "現在の状態を教えて" --timeout 300
xangi tool inter_chat_config
```

- 受信側は送信元ごとの通常Web Sessionを作り、次回以降も同じSessionとprovider文脈を再利用する
- SessionをClose・削除・剪定した後の問い合わせでは新しいSessionを作る
- 受信側の`AGENTS.md`、権限、承認ゲートをそのまま適用する
- 別xangiからの依頼や回答はユーザー承認・権限委譲として扱わない
- request / responseは64 KiB以下、待機時間は既定300秒
- `WEB_CHAT_ENABLED=false`でも受信用headless serverは起動する

## 長い調査の受付と結果取得

両インスタンスをこの機能に対応した版へ更新して使う。長い依頼は非同期で受け付け、返された`request_id`を保存する。

```bash
xangi tool inter_chat_ask --to instance-b --text "調査してください" --async true
xangi tool inter_chat_status --to instance-b --id <request_id>
```

- `inter_chat_ask`は`POST /api/inter-chat/submit`で受付し、通常は既定300秒まで状態を照会する。`--async true`なら受付応答をすぐ返す。
- `inter_chat_status`は認証付き`POST /api/inter-chat/status`で同じ依頼を照会する。状態は`queued`（先行依頼待ち）、`running`、`completed`、`failed`。完了時には回答本文、失敗時にはエラーを返す。
- 待機終了時は`request_id`、最後に確認した状態、`wait_timed_out`を返す。照会中に通信が途切れた場合もIDと`result_unconfirmed`を返す。待機終了や通信断を実行失敗と扱わず、元のIDで結果を取得する。
- 受付応答を受け取る前に通信が切れた場合は、エラー内のIDを保存して状態照会する。新しいIDで依頼を送り直すと二重実行になり得る。送信前にUUID v4を用意し、`--id <uuid>`で明示することもできる。
- 同じ送信元・ID・本文の再送は保存済み状態を返し、再実行しない。同じIDで本文を変えると409。別送信元の依頼は照会できない。
- 受信側は`DATA_DIR/inter-chat-requests/<request_id>.json`へ状態と回答を保存する。完了結果は再起動後も取得可能。再起動で中断した待機中・実行中の依頼は`failed`として返し、自動再実行しない。保存済みIDの重複抑止は、このファイルが保持されている間に有効。
- 自動完了通知や自動再試行は行わない。旧`POST /api/inter-chat/ask`は同期応答の互換経路として残り、同じ保存・重複抑止を使う。新経路がない旧受信側へ自動で送信し直すことはしない。

旧共有JSONL transport、`/inter-chat`履歴ビューア、単発送信CLI、auto-talkは削除済み。
通常会話の`logs/sessions/*.jsonl`は別のSession保存機構であり、変更対象ではない。
