---
description: リリース前の最終チェックを一括実行する（typecheck → lint → test → build）
---

# Release Check

xangi をリリース／PR マージ前に必ず通すべきチェックを順に実行する。

## 実行手順

1. `npm run typecheck`
2. `npm run lint`
3. `npm test`
4. `npm run build`

各ステップで失敗が出た場合は止めて、原因を要約してユーザーに報告する。
すべて成功したら、現在のブランチ名・コミット数・最後のコミットメッセージをまとめて出力する。

## やらないこと

- 失敗を握りつぶして次のステップに進まない
- 自動で `git commit` / `git push` しない
- 失敗時に勝手に `--fix` 系を実行しない（必ず差分を提示してから）
