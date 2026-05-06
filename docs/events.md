# 外部イベントストリーム（pull 型 SSE）

xangi はチャット応答のライフサイクルを SSE（Server-Sent Events）で配信する。consumer（デスクトップアバター、ダッシュボード、可視化ツール等）が `GET /api/events/stream` に接続すれば、いま xangi が何をしているかをリアルタイムに購読できる。

Discord / Slack / Web Chat の **全プラットフォーム共通**でイベントが流れる。consumer は `platform` フィールドや `thread_label` を見て表示分けする。

> **2026-05-06 設計変更**: 旧 push 型（`XANGI_EVENTS_URLS` で receiver に POST する方式）は廃止した。「xangi 側がペット数や URL に依存する」「receiver 増減のたびに `.env` 編集 + 再起動が要る」「N=0 の receiver でも fetch を投げる」のがしんどく、pull 型 SSE 一本化に切り替えた。**xangi の設定変更ゼロで N 台の consumer を繋げる**のがゴール。

## エンドポイント

```
GET http://<xangi-host>:<WEB_CHAT_PORT>/api/events/stream
```

- web-chat の HTTP サーバに相乗り（デフォルト port `18888`）
- `Content-Type: text/event-stream`
- 接続直後に `event: ready` を 1 回（`instance_id` / `host_hint` を payload）
- 以後、操作的イベント（後述）が `data: <JSON>\n\n` の形で流れる
- 30 秒ごとに `: keepalive` コメント行（中継 proxy の idle 切断対策）
- consumer が切断したら subscriber を解除して keepalive timer を止める

起動時のログに、Tailscale が動いていれば MagicDNS / Tailscale IP 経由のアクセス URL も `[xangi-events (SSE)] Access URLs:` セクションに出る。

## 設計方針

- xangi 側は **操作的イベント**だけを流す。`thinking` / `talking` / `idle` のような状態ラベルは送らない
- 状態は consumer 側で派生させる
  - `turn.started` 受信後 `message.delta` まだなし → "thinking"
  - `message.delta` が 1 回でも来た → "talking"
  - `turn.complete` または `turn.aborted` 受信後 → "idle"
- 配信は **subscriber へのブロードキャスト**。subscriber 数が 0 でもイベントは無害（捨てるだけ）
- subscriber が例外を投げても他の subscriber には影響しない（本業を止めない）
- **サーバ側フィルタなし**。複数 instance / 複数 thread を区別したいときは consumer 側で `instance_id` / `thread_id` / `platform` を見て自分で絞る

## 環境変数

| 変数 | デフォルト | 説明 |
|---|---|---|
| `WEB_CHAT_PORT` | `18888` | SSE エンドポイントを公開する HTTP サーバのポート |
| `XANGI_EVENTS_ENABLED` | `true` | `false` で完全に無効化（接続要求は 503 で返す） |
| `XANGI_INSTANCE_ID` | `xangi-<hostname>-<sha1(DATA_DIR)[:6]>` | このインスタンスを区別する識別子。複数の xangi を同じ consumer に繋ぐときに consumer 側でフィルタするために使う |

### `instance_id` の自動採番

`XANGI_INSTANCE_ID` を明示指定しなかった場合、xangi は次のフォーマットで自動採番する:

```
xangi-<hostname>-<sha1(DATA_DIR)[:6]>
```

- 同じ PC・同じ `DATA_DIR` で再起動 → 同じ ID（consumer 側のフィルタ設定が壊れない）
- 同じ PC・別 `DATA_DIR` → 自動的に別 ID

複数インスタンスを運用する場合は明示指定推奨:

```bash
# .env
XANGI_INSTANCE_ID=xangi-prod
```

## イベントスキーマ

### `event: ready`（接続直後 1 回）

```jsonc
{ "instance_id": "xangi-prod", "host_hint": "<hostname>" }
```

### 全操作イベント共通フィールド

```jsonc
{
  "type":         "<event type>",
  "instance_id":  "xangi-prod",         // 送信元 xangi の識別子
  "host_hint":    "<hostname>",         // 表示用ヒント（実体は instance_id を使う）
  "platform":     "discord",            // "discord" | "slack" | "web"
  "thread_id":    "discord:<channelId>",
  "turn_id":      "discord-msg-<messageId>",
  "thread_label": "#general",           // 人間が読む表示名（任意）
  "ts":           1730000000            // unix 秒
}
```

### `thread_id` の組み立て

| platform | thread_id | turn_id | thread_label の例 |
|---|---|---|---|
| discord | `discord:<channelId>` | `discord-msg-<messageId>` | `#general` / `DM` |
| slack | `slack:<channelId>` | `slack-msg-<ts>` | `#general` / `Slack DM` |
| web | `web:<appSessionId>` | `web-msg-<unix-ms>` | セッションタイトル / `Browser session` |

### `turn.started`

ユーザーメッセージ受信時に 1 回。

```jsonc
{ "type": "turn.started", ..., "user_text": "..." }
```

### `message.delta`

エージェントの応答テキストがストリーミングで届くたび。

```jsonc
{
  "type": "message.delta",
  ...,
  "text":      "<このチャンクの差分>",
  "full_text": "<ターン開始からの累積>"
}
```

### `turn.complete`

ターンが正常完了したとき 1 回。

```jsonc
{ "type": "turn.complete", ..., "text": "<最終応答テキスト>" }
```

### `turn.aborted`

ユーザー操作でキャンセルされたとき 1 回。

```jsonc
{ "type": "turn.aborted", ... }
```

### `agent.error`

例外が発生したとき 1 回。`turn.complete` / `turn.aborted` とは排他。

```jsonc
{ "type": "agent.error", ..., "message": "<error message>" }
```

## 1 ターンの流れ

正常完了:

```
turn.started → message.delta × N → turn.complete
```

キャンセル:

```
turn.started → message.delta × M → turn.aborted
```

エラー:

```
turn.started → (message.delta × M)? → agent.error
```

## consumer 実装例

### Node.js（標準 http で生 SSE をパース）

```js
import { request } from 'http';

const req = request(
  { host: 'localhost', port: 18888, path: '/api/events/stream', method: 'GET' },
  (res) => {
    let buf = '';
    res.setEncoding('utf-8');
    res.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const dataLine = block.split('\n').find((l) => l.startsWith('data: '));
        if (!dataLine) continue;
        const ev = JSON.parse(dataLine.slice(6));
        // self-filter したいなら ここで ev.instance_id / ev.platform をチェック
        console.log(ev);
      }
    });
  }
);
req.end();
```

### ブラウザ（EventSource）

```js
const es = new EventSource('http://localhost:18888/api/events/stream');
es.addEventListener('ready', (e) => {
  const { instance_id } = JSON.parse(e.data);
  console.log('connected:', instance_id);
});
es.onmessage = (e) => {
  const ev = JSON.parse(e.data);
  if (ev.type === 'turn.started') {
    /* ... */
  }
};
```

### consumer 側 self-filter の例

「自分のインスタンス（`xangi-prod`）の Web セッションだけを表示したい」場合:

```js
if (ev.instance_id !== 'xangi-prod') return;
if (ev.platform !== 'web') return;
// 表示処理...
```

サーバ側で絞り込みパラメータ（`?instance=...` 等）はあえて持たせていない。consumer 側で自分の責務に応じて絞るのが pull 型のいいところ。

## 動作確認

```bash
# 1. xangi を起動（WEB_CHAT_ENABLED=true で web-chat サーバが上がる）
npm run start

# 2. 別ターミナルで SSE を覗く
curl -N http://localhost:18888/api/events/stream

# 3. xangi に Discord / Web からメッセージを送る
#    → curl 側に turn.started → message.delta × N → turn.complete が流れる
```
