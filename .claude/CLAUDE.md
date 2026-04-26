# xangi — Project Memory for Claude Code

> Discord / Slack から Claude Code / Codex / Gemini CLI / Local LLM を扱う AI アシスタント Bot。

## 技術スタック

- TypeScript（strict, ES2022 / NodeNext ESM）
- Node.js >= 22
- discord.js v14 / @slack/bolt v4
- vitest（テスト）/ eslint v9 / prettier v3
- husky + lint-staged（pre-commit で eslint・prettier・vitest・tsc を実行）

## ビルド・テスト・実行コマンド

```bash
npm run build       # tsc → dist/
npm run dev         # tsx watch src/index.ts
npm start           # node dist/index.js
npm test            # vitest run（一回）
npm run test:watch  # vitest watch
npm run lint        # eslint src/
npm run lint:fix    # eslint --fix
npm run format      # prettier --write src/
npm run typecheck   # tsc --noEmit
```

変更後は最低限 `npm run typecheck` と `npm test` を通すこと。

## ディレクトリ構成（要点のみ）

- `src/index.ts` — エントリーポイント。Discord/Slack 受信 → AI CLI 呼び出しまでオーケストレーション
- `src/agent-runner.ts` — AI CLI 抽象化インターフェース
- `src/{claude-code,codex-cli,gemini-cli,local-llm}.ts` — 各バックエンド実装
- `src/persistent-runner.ts` — Claude Code 常駐プロセス（stream-json）
- `src/scheduler.ts` / `src/schedule-cli.ts` — cron 系スケジューラ
- `src/safe-env.ts` — 環境変数ホワイトリスト
- `tests/*.test.ts` — vitest テスト（実装と1対1対応）
- `docs/design.md` — アーキテクチャ詳解（設計を理解したいときの一次ソース）

## コーディング規約

- ESM（`.js` 拡張子付き import を維持: `import { foo } from './bar.js'`）
- 既存の言語スタイルに合わせる（コード内コメントは日本語、識別子は英語）
- `any` は `warn`、未使用変数は `_` プレフィックスで除外
- 例外を握りつぶさない。エラーメッセージはユーザー（Discord/Slack）に届く前提で書く
- 新しい依存追加は最小限に（書籍題材なので学習者が読める量を意識）

## テスト方針

- 実装ファイルごとに `tests/<name>.test.ts` を作成
- ネットワーク・Discord/Slack/AI CLI など外部依存はモック
- vitest の `vi.mock` を使い、副作用は分離
- pre-commit で全テスト走るので、テストが落ちる状態で commit しない

## 不可侵ルール（Critical）

- **`.env` / シークレット類を読み出さない・出力しない・ログに残さない**
- `safe-env.ts` のホワイトリストを通らない環境変数を AI CLI に渡さない
- 明示的指示なく `git commit` / `git push` / `npm publish` しない
- 本番 Bot トークン（`DISCORD_TOKEN` 等）を含む可能性のある場所への外部送信禁止
- 破壊的操作（`rm -rf`, `git reset --hard`, `git push --force`）は確認必須

## バックエンド別の前提

| Backend | 自動読込ファイル | 備考 |
|---|---|---|
| Claude Code | `CLAUDE.md` | `--append-system-prompt` で一回注入 |
| Codex CLI | `AGENTS.md` | `<system-context>` 埋め込み |
| Gemini CLI | `GEMINI.md` | CLI 側で自動読み込み |
| Local LLM | `AGENTS.md` / `MEMORY.md` | システムプロンプトへ直接埋め込み |

## 関連ファイル参照

@README.md
@docs/design.md
