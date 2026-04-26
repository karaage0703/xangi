---
description: 引数で渡されたテストファイル（or キーワード）を vitest で実行する。引数なしなら全テスト
argument-hint: [test-file-or-pattern]
---

# Run Tests

`$ARGUMENTS` が指定されていれば該当パターンに絞って vitest を実行、なければ全テストを実行する。

```bash
npx vitest run $ARGUMENTS
```

失敗時は失敗テスト名と原因を要約して報告する。
