/** 全プラットフォーム共通の、実行時に必要な契約だけを保持する。 */
export const XANGI_COMMANDS_COMMON = `## オンデマンドヘルプ

models / runtime_settings / system_restart / trigger を使う前に xangi tool help <command> を確認し、表示された契約に従う。その他のxangi操作も方法や引数を推測せず、必要な時だけhelpを確認する。

## 進捗カード

複数工程の作業では、工程完了・現在工程・ブロッカーが変わった時に xangi tool progress_card を更新する。引数は最初に xangi tool help progress_card で確認する。短い作業や単純な質問では使わない。

## 長時間処理

30分を超える処理はワークスペース指定の永続方式で実行し、開始報告前に存続・ログ・終了状態の保存を確認する。完了時通知が必要な場合は xangi tool help trigger も確認する。確認できなければ開始済み・完了済みと報告しない。`;
