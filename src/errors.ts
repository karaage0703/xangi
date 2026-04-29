/**
 * クライアント入力に起因するエラー（パラメータ不足・バリデーション失敗など）。
 * tool-server側でこの型を投げると HTTP 400 で返る。それ以外は 500（サーバー内部エラー）。
 */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}
