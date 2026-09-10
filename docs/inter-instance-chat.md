[English](en/inter-instance-chat.md) | 日本語

# inter-instance-chat — xangi インスタンス間連携

xangi の複数インスタンスが、Discord/Slackを介さず認証付きHTTPでタスクをやり取りする機能。
ユーザーが現在のxangiへ「`instance-b`に○○を聞いて」と頼むと、agentは
`inter_chat_ask`で宛先を指定し、回答を待って元の会話へ返す。

```text
ユーザー → instance-a → POST /api/inter-chat/ask → instance-b
                              Bearer token             ↓
ユーザー ← instance-a ←──────── HTTP応答 ───── 通常Web Session
                                                    （履歴・継続文脈）
```

同一マシン・別マシンの両方に対応する。別マシン間ではTailscale内での利用を推奨する。

## 設定

```bash
INTER_INSTANCE_CHAT_ENABLED=true
INTER_INSTANCE_CHAT_TOKEN=<十分長い共通秘密値>
INTER_INSTANCE_CHAT_PEERS='{"instance-a":"http://100.64.0.1:18888","instance-b":"http://100.64.0.2:18888"}'
INTER_INSTANCE_CHAT_ALLOWED_PEERS=instance-a,instance-b
WEB_CHAT_HOST=100.64.0.2
XANGI_INSTANCE_ID=my-instance
XANGI_INSTANCE_LABEL=my-instance
```

`INTER_INSTANCE_CHAT_ALLOWED_PEERS`は受信元instance IDのallowlist。未設定または`*`は、
正しいBearer tokenを持つ全instanceを許可する。

## 指名問い合わせ

通常のDiscord / Slack / Web Chatで「instance-bに現在の状態を聞いて」のように依頼する。
共通プロンプトがこの表現を検出し、Tool Server経由で次を実行する。

```bash
xangi tool inter_chat_ask --to instance-b --text "現在の状態を教えて" --timeout 300
xangi tool inter_chat_config
```

- 受信側は送信元ごとの通常Web Sessionを作り、次回以降も同じSessionとprovider文脈を再利用する
- SessionをClose・削除・剪定した後の問い合わせでは新しいSessionを作る
- 受信側の`AGENTS.md`、権限、承認ゲートをそのまま適用する
- 別xangiからの依頼や回答はユーザー承認・権限委譲として扱わない
- request / responseは64 KiB以下、待機時間は既定300秒
- `WEB_CHAT_ENABLED=false`でも受信用headless serverは起動する

旧共有JSONL transport、`/inter-chat`履歴ビューア、単発送信CLI、auto-talkは削除済み。
通常会話の`logs/sessions/*.jsonl`は別のSession保存機構であり、変更対象ではない。
