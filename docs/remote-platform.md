# Remote Platform Adapter（実験的）

Remote Platform Adapterは、Discord/Slack tokenをhost側Gatewayに残したまま、受信eventをxangiの通常session・Agent・共通event処理へ渡すための内部APIです。NemoXangiのような隔離構成向けであり、公開Internet向けAPIではありません。

```text
Discord / Slack
  ⇅
host Platform Gateway（credential、API I/O、coarse allowlist）
  ⇅ 認証済みSSE
xangi Remote Platform Adapter（session、Agent、共通event）
```

## 有効化

```dotenv
WEB_CHAT_ENABLED=false
XANGI_REMOTE_PLATFORM_ENABLED=true
XANGI_REMOTE_PLATFORM_TOKEN=<十分に長いランダム値>
WEB_CHAT_HOST=127.0.0.1
```

`POST /api/remote-platform/turn`へ`Authorization: Bearer ...`を付けて送信します。`platform`、`contextKey`、`settingsChannelId`、`channelId`、`messageId`、`userId`、`userName`、`text`が必須です。応答は`started`、`text`、`tool`、`error`、`done`のSSE eventです。同じxangi sessionへの同時turnは`409 Session is busy`で拒否されます。

このtokenはplatform credentialではありませんが、任意の発話をxangiへ投入できる権限です。未設定時はendpointを`503`、不一致時は`401`にし、host Gatewayとxangiの間だけで共有してください。raw Discord/Slack tokenをxangiやAgent processへ渡してはいけません。
