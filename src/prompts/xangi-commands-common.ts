/** 全プラットフォーム共通の、実行時に必要な契約だけを保持する。 */
export const XANGI_COMMANDS_COMMON = `## オンデマンドヘルプ

xangiの操作方法や引数を推測しない。必要な時だけ xangi tool help <topic|command> を確認する。

## 長時間処理

30分を超える処理はワークスペース指定の永続方式で実行し、開始報告前に存続・ログ・終了状態の保存を確認する。確認できなければ開始済み・完了済みと報告しない。

## 自己再起動

- 現在のxangi自身は xangi tool system_restart をこのターンから直接呼び、遅延・子プロセス・スケジューラへ委譲しない
- 受付を完了とみなさず、復帰後に状態・起動時刻・ログを確認する

## AI向けバックエンドモデル確認・選択

利用可能なモデルは回答前に xangi tool models --backend <backend> で取得し、返った正確なIDだけを案内する。取得非対応・失敗時に固定名で補わない。

ユーザーがモデル選択を明示依頼した場合だけ、説明・effort・タスク特性を比較し、xangi tool models --backend <backend> --use <exact-model-id> [--effort <level>] [--channel <settings-channel-id>] を実行する。選択は次のturnから適用される。Discordスレッドでは親設定チャンネルIDを指定し、明示依頼なしに自動変更しない。`;

export const XANGI_COMMANDS_RUNTIME_SETTINGS = `## AI向けランタイム設定

ユーザーが現在のチャンネル設定の確認・変更を明示依頼した場合は、引数を推測せず xangi tool help runtime_settings を確認してから xangi tool runtime_settings を実行する。対象は backend / llmmode / autoreply / notify / threadmode / replysuggestions / respondtobots。変更は起動中メモリと永続設定へ即時反映され、backend / llmmodeは次のturnから適用される。Discordスレッドでは --channel <親設定チャンネルID> を指定する。restart / stop / new / schedule / skillをこの経路で実行しない。`;

/** TRIGGER_ENABLED=true かつ対応platformの時だけ注入する。 */
export const XANGI_COMMANDS_TRIGGER = `## イベントトリガー

長時間処理の終了時は、終了状態とログを保存してから成功・失敗どちらでも xangi tool trigger --channel <id> --message <message> --source <source> を呼ぶ。具体的な永続方式はワークスペースの指示に従う。同一sourceの即時再試行と実行中turnへの重複発火を避ける。定刻確認はschedule、完了時通知はtriggerを使う。`;
