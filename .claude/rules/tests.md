---
paths:
  - "tests/**/*.ts"
---

# tests/ 配下の規約

- 1 実装ファイル = 1 テストファイル（`src/foo.ts` → `tests/foo.test.ts`）
- vitest の `describe` / `it` で構造化。トップレベル `it` も許容するが既存ファイルのスタイルに揃える
- 外部依存は `vi.mock` でモック化：
  - `discord.js`, `@slack/bolt`
  - `child_process` / `node:child_process`（AI CLI 呼び出し）
  - `node:fs` / `node:fs/promises`（必要に応じて）
- 各テストは独立。`beforeEach` で状態をリセット、`afterEach` でモックを解除（`vi.restoreAllMocks()` 等）
- 実トークン（`DISCORD_TOKEN` 等）に依存するテストは書かない
- ネットワーク I/O を伴うテストは書かない（必要なら nock 系ではなく自前モック）
- スナップショットは原則使わない（差分が読みづらいため）
