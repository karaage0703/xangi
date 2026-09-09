# 実行モデルの確認元

実行履歴には、指定したモデルとプロバイダーが実行時に報告したモデルを分けて保存する。情報が得られなければ不明のまま残し、現在のCLI設定で過去の実行を推測しない。1ターンで使われた複数のモデルと、最後に確認したモデルをそれぞれ記録する。

- **Claude Code:** 常駐プロセスを含め、`system/init.model` とメイン会話の `assistant.message.model` を取得する。`parent_tool_use_id` のある子エージェントのイベントは除外する。集計 `modelUsage` は補助処理を含みうるため採用しない。JSONのみを返す `run()` では不明になる場合があり、ストリーミング・常駐実行では構造化イベントを参照する。
- **Codex:** ネイティブイベントのモデル情報と、セッションID・作業ディレクトリ・実行時刻が一致するrolloutの `turn_context.model` を参照する。現在の設定ファイルは過去の証拠に使わない。
- **Cursor / Grok:** CLIが返すassistant/system/resultのモデル情報を参照する。`auto`という指定や回答本文は、実際に選択されたモデルの証拠にはしない。
- **GitHub Copilot:** `assistant.usage.data.model` を取得する。subagent・sampling・background・compactionと分類されたイベントは除外する。型は導入済みのMITライセンスの `@github/copilot-sdk` に基づく。古いメイン会話イベントとの互換性のため、分類がない場合は受け入れる。
- **OpenCode:** JSONLの断片にはモデルIDがないため、完了後に読み取り専用の `opencode export <sessionID>` を実行する（最大5秒・32 MiB）。セッションID・実行時刻・作業ディレクトリが一致するassistant metadataだけを採用し、summaryは除外する。失敗・非対応・情報欠落時は不明にする。追加のモデル推論は行わない。コマンドは[公式CLI文書](https://opencode.ai/docs/cli#export)、`modelID`・`providerID`・`time.created`・`sessionID`・`path.cwd`・`summary` は[公式SDK](https://opencode.ai/docs/sdk)の導入済みMIT型定義を参照する。
- **Antigravity:** ネイティブinit/resultにモデル情報があれば取得する。従来の自由文や通常のJSON回答からは推測しない。
- **Local LLM:** OpenAI互換・Ollama APIのレスポンス `model` を、通常応答・ストリーミング・ツールループの各呼び出しで取得する。レスポンスにない場合、リクエストのエイリアスで実測値を埋めない。
- **Extensionバックエンド:** schema version 1の任意フィールド `model`・`models` を取得する。Extensionはメイン会話のモデルだけを返し、`model` に最後の観測、`models` に観測したモデルを入れる。既存Extensionはフィールド省略でも互換性を維持し、モデル不明として記録する。

確認できるのはプロバイダーが報告した識別子までで、内部の配備・ルーティングそのものではない。モデル情報を返さないCLIでは、明示指定だけを根拠に実行確認済みとは表示しない。
