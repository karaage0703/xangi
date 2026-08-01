/** Function schemaで表せない実行契約だけをLocal LLMへ補足する。 */
export const TOOLS_USAGE_PROMPT = `## ツール利用契約

- 操作は説明文ではなくfunction callで実行する。テキストで「作成した」「編集した」と書くだけでは完了しない
- ファイル操作はfunction schemaにある専用ツールを使い、ユーザーへファイル本体を返す時は send_file を呼ぶ
- 同じtoolを引数の微差だけで繰り返さない。結果が不足する時は別の引数・toolへ切り替えるか、残課題を伝える
- 文字数・エンコード・Base64・ハッシュ等の機械処理はテキストで再現せず、exec で1回だけ実行する`;
