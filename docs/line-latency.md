# LINEの返信遅延を調べる

LINEのイベント発生、Webhookの受信、キュー待ち、画像取得、AI実行、返信APIを別々に測る。
`[line-latency]` に続くJSONが診断用ログ。PM2ならアプリのstdoutログに保存される。
本文・添付内容・URL・アクセストークン・replyToken・生のユーザーIDは含めない。
`conversationKey` / `messageKey` / `eventKey` はSHA-256の先頭16桁、`traceId`は受信ごとのUUID。
既存の会話履歴・バックエンドのstderrとは別なので、調査用に共有する際はこのプレフィックスだけを抽出する。

## どこが遅いか

| 証拠 | 読み方 |
| --- | --- |
| `webhook_received.deliveryLagMs` | LINEイベント時刻からHTTPハンドラ開始まで。大きければアプリ内キューより前。携帯のアップロード、LINE、公開経路のどこが遅いかは単独では断定できない |
| `webhook_received.sinceReceiptMs` | HTTPハンドラ開始から署名検証・イベント解析まで。リクエストボディ受信の遅れも含む |
| `processing_start.queueWaitMs` | xangi内の順番待ち。`queue_enqueued.blockingTraceId`で先行処理を追える。定期実行も同じ計測対象 |
| `media_start` → `media_success` / `media_failure` | コンテンツ取得（ヘッダ・本体・保存を含む） |
| `agent_start` → `agent_success` / `agent_failure` | Codex等の実行全体。`agent_backend_ready`、`agent_turn_started`、`agent_resume_retry`で起動・競合を切り分ける |
| `send_start` → `send_success` / `send_failure` | LINE API応答まで。`mode`はreply/push、`purpose`はfinal/notice/command/schedule |
| `send_success.eventToApiAcceptedMs` | LINEイベント発生から送信API成功まで（携帯への配達・表示完了ではない） |
| `event_loop_delay.durationMs` | Node.jsの処理が1秒以上滞った場合の最大遅延（15秒ごとに集計） |

`at` / `receivedAt` / `eventAt`はUTCのISO時刻。日本時間は+9時間。
区間の`durationMs`とキュー待ちは単調増加時計で計測する。イベントとの比較は壁時計を使うので、
PiのNTP同期も確認する。負の`deliveryLagMs`は時計のずれ等を示すため、そのまま残す。

## 再発時の手順

1. おおよその日本時間と、利用者が送った時刻・返った時刻を確認する。
2. PM2のstdoutログから、その時間帯の`[line-latency]`だけを抽出する。
3. `traceId`ごとに上表の区間を比較する。終端がない`*_start`はまだ進行中の可能性がある。
4. キュー待ちなら`blockingTraceId`のmedia/agent/sendと、`kind=schedule`を確認する。
5. `deliveryLagMs`が長ければ同じ時間帯の公開経路のログ、`event_loop_delay`、LINE DevelopersのWebhookエラー統計を照合する。
6. `redelivery=true`はLINEによる再送。同じ`eventKey`の受信を照合する。再送だけで遅延原因を断定しない。

同時送信画像では、各画像の取得はキュー投入より前に始まる。揃う前のイベントは`image_set_waiting`で止まり、最後に揃えたイベントのtraceがキュー・AI・返信を記録する。

例（パスはPM2の設定に合わせる）:

```sh
rg '\[line-latency\]' ~/.pm2/logs/xangi-out-*.log
# 1メッセージだけ追跡する
rg '\[line-latency\]' ~/.pm2/logs/xangi-out-*.log | rg '<traceId>'
```

LINE Developers: Messaging API設定 → Webhook設定 → エラーの統計情報 → Webhookエラー。
集計を有効にしていなかった期間は遡及できない。エラーがない場合も、正常応答した配信の遅れは除外できない。
[LINE公式のエラー統計](https://developers.line.biz/ja/docs/messaging-api/check-webhook-error-statistics/)

## 時間制限と失敗時の扱い

| 設定 | 既定値 | 対象 |
| --- | --- | --- |
| `LINE_API_TIMEOUT_MS` | 15秒 | reply / push / loading。ヘッダとレスポンス本体を含めてabort |
| `LINE_MEDIA_TIMEOUT_MS` | 60秒 | 画像・動画・音声・ファイル取得全体。失敗時は添付取得不可としてAIへ渡す |
| `LINE_AGENT_TIMEOUT_MS` | `TIMEOUT_MS`（未設定なら30分） | 同一ターンの再試行を含むAI全体。対話と定期実行で共通 |

LINE SDKのクライアントはリクエスト期限を公開していないため、利用中の3つの送信エンドポイントを
SDKの型を保った小さなfetchクライアントで呼ぶ。別プラットフォームの通信制御は変えない。

AIの期限が来たらcancelを要求してキューを解放する。バックエンドがcancelを無視しても、
同じ会話へ新たなAIを重ねない。古いPromiseが完了するまでは後続のAI処理をすぐエラーで終了し、
待ち続けずに利用者へ失敗を返す（`previous_agent_pending`）。古い処理が終われば自動復帰する。
この状態が続く場合は当該バックエンドの停止を調べる。無関係なプロセスを一括でkillしない。

送信失敗時は、明確なHTTP 400のreply拒否だけpushへ切り替える。
タイムアウト・通信切断・5xxは「既に届いたか不明」なので自動再送しない。
送信APIが落ちている間はエラー通知自体も届かないが、後続のキューは処理を続ける。

## 返信内の時間表示

`✅ 完了（送信→返信準備 4分17秒 / AI 16秒）` のように待ち時間を含める。
「送信」の基準はLINEのイベントtimestampであり、携帯の送信ボタンを押した時刻そのものは取得できない。
timestampが欠落・未来の場合は`受信→返信準備`を使う。
この文面を作る時点では送信完了はまだ不明なので「返信準備」と表示する。
実際にLINE APIが成功するまでの時間は`send_success`で確認する。

## 検証

```sh
npx vitest run tests/line-latency.test.ts tests/line-http-timeouts.test.ts tests/codex-resume-retry.test.ts
```

外部LINE送信や有料モデル実行を使わず、ローカルHTTPサーバでヘッダ停止・本体停止・503、
キュー待ち、キャンセル無視、Codexセッション競合を再現する。
署名付きWebhookがAI完了を待たず200を返すこと、個人情報が診断ログに入らないことも検証する。
