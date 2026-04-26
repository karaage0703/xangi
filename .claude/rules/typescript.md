---
paths:
  - "src/**/*.ts"
---

# TypeScript / src 配下の規約

- ESM 構成のため、相対 import は **`.js` 拡張子付き** で書く（例: `import { foo } from './bar.js'`）
- `tsconfig.json` は `strict: true`。型回避（`as any` / `// @ts-ignore`）は原則禁止。やむを得ない場合はコメントで理由を残す
- 未使用引数は `_` プレフィックスで除外（eslint 設定に合わせる）
- 例外を握りつぶさない。`catch` した場合は最低でもログに残すか、上位に再 throw する
- 環境変数アクセスは `src/safe-env.ts` のホワイトリスト経由を優先
- 副作用のあるトップレベル文（`new Client()` など）は最小限に。テスト容易性のため関数化する
- ファイル末尾に改行（prettier に従う）
- コメント：自明な「何をしているか」は書かない。「なぜそうしているか」のみ書く
