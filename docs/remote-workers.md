# Remote workers (MVP)

Remote workerはMac、Linux、Windows上の計算資源や接続デバイスをxangiから利用するためのnodeです。workerからxangi Gatewayへ外向きWebSocket接続するため、worker側の受信portやSSHログインを必要としません。

初版のcapabilityは次の3つです。

- `system.info`: OS、architecture、CPU数、memory、capabilityと、現在有効なworkspace/command allowlistを返す
- `exec`: 許可されたworkspace内で、許可されたcommandをshellを介さずargvで実行する
- `usb.list`: macOSの`system_profiler`、Linuxの`lsusb`、WindowsのPowerShellでUSBを列挙する

USBへの書込みやserial操作は初版には含みません。対象deviceとoperationを個別に許可するcapabilityとして追加します。

## Gateway

推奨はsingle-use pairingです。Gatewayで10分有効のpair URIを発行します。

```bash
xangi tool remote_worker --action pair-create --worker example-mac \
  --gateway-url ws://100.64.0.1:18791/api/remote-workers/connect
```

Macでは既存のxangi配布物をworker modeとしてlaunchdへ登録します。`--workspace`を省略すると実行時のdirectoryだけを許可します。

```bash
xangi worker install --pair 'xangi-pair://...' --workspace /Users/you/project
xangi worker status
```

pair URIは1回使うと即失効します。交換後の長期tokenと設定は`~/.config/xangi/worker/`へmode 0600で保存され、`~/Library/LaunchAgents/dev.xangi.worker.plist`がworkerだけを自動起動します。LLM、Web UI、chat platform、schedulerは起動しません。

管理コマンド:

```bash
xangi worker start
xangi worker stop
xangi worker restart
xangi worker status
xangi worker uninstall
```

`start`は未登録のLaunchAgentを登録し、登録済みで停止中なら`kickstart`で起動します。すでに実行中の場合は再起動しません。`restart`は現在のCLIからlaunchd設定を再生成し、既存の認証情報を保持して起動します。worker自身から実行しても停止に巻き込まれないよう、別の一時launchd jobへ再登録処理を引き継いでから受付元を終了します。launchdの登録解除完了を待ってから再登録するため、削除中のserviceとの競合も避けます。コマンドは再起動の受付後に返るため、完了確認は`remote_worker --action list`で再接続を確認してください。Git checkout更新後も再ペアリングは不要です。TypeScriptから導入した場合は実行用loaderの絶対URLも登録します。`status`はlaunchdのrunning状態とPIDを確認しますが、Gatewayへの接続確認は別途必要です。

手動設定も利用できます。tokenを生成し、xangi hostだけが読めるmode 0600のfileへ保存します。token自体を`.env`や会話、command lineへ書かないでください。

`workers.json`:

```json
[
  {
    "id": "example-mac",
    "tokenFile": "/absolute/path/to/example-mac.token"
  }
]
```

`.env`:

```dotenv
XANGI_REMOTE_WORKERS_CONFIG=/absolute/path/to/workers.json
XANGI_REMOTE_WORKER_HOST=0.0.0.0
XANGI_REMOTE_WORKER_PORT=18791
```

`0.0.0.0` bindはTailnetや同等の信頼できるprivate network内だけで使ってください。MVPの`ws://` transportはnetwork自体の暗号化を前提にします。public networkでは公開せず、将来の`wss://`またはTLS reverse proxyを使います。

## Worker node

Mac側の例です。`gatewayUrl`にはMacから到達できるxangi hostのTailnet IPを指定します。

```json
{
  "gatewayUrl": "ws://100.64.0.1:18791/api/remote-workers/connect",
  "workerId": "example-mac",
  "tokenFile": "/Users/you/.config/xangi/remote-worker.token",
  "workspaceRoots": ["/Users/you/project"],
  "allowedCommands": [
    "/usr/bin/git",
    "/opt/homebrew/bin/node",
    "/opt/homebrew/bin/npm",
    "/opt/homebrew/bin/python3.12",
    "/usr/bin/python3",
    "/usr/bin/uname"
  ]
}
```

初回install時は、実機に存在するHomebrewのNode.js・npm・Python 3系も既定allowlistへ追加します。既存設定は自動上書きしないため、必要な実行fileを`allowedCommands`へ追加した後に`xangi worker restart`で反映してください。

```bash
xangi worker run --config /absolute/path/to/worker.json
```

`worker status`はプロセスの稼働状態に加え、同じPIDのworkerが保存したGateway状態、状態更新時刻、最終接続確認、直近エラー、切断コード、次の再試行時刻、実行中CLIとNodeのpathを表示します。状態は設定ファイルと同じdirectoryの`worker-status.json`へmode 0600で保存します。古いworker・状態ファイル欠損・PID不一致では`unknown`を表示します。停止中のプロセスについて古い接続状態を表示しません。

`connected`はGatewayの認証受理通知、または認証後の要求を受けた時点の記録です。WebSocketを開いただけでは`awaiting-confirmation`です。古いGatewayは受理通知を返さないため、最初の要求まで確認待ちになります。定期的な死活監視はまだ行わないので、`connected`も現在の応答可能性を保証しません。必要ならGateway側から`info`で応答を確認してください。

接続・切断・再試行はMacの`worker.log`、Linux/WSL2のjournalにJSONで記録します。token、接続先URL、生のエラー文・任意の切断理由は記録せず、既知のエラー分類・HTTP status・既知の切断理由と切断コードを残します。状態ファイルの保存に失敗してもworkerの接続処理は継続し、保存失敗をログへ記録します。

`xangi update`はローカルworkerと本体を自動再起動せず、反映には`xangi restart`が必要と案内します。明示的な`xangi restart`はworker、本体の順に再起動し、managed版は`app/current`のNode/CLIでworker起動設定を再生成します。停止中・未導入workerはskipします。restartの受付・完了・失敗の確認は表示されたresult/logで行い、Gateway再接続は別途確認してください。worker単独の再起動は引き続き更新後のCLIから`worker restart`で行えます。古いCLIからの単独restartは古い版を再登録し得ます。再ペアリングは不要です。今回の診断表示は既存workerにも自動適用されず、新コードでのworker再起動が必要です。

nodeは切断後に自動再接続します。`worker install`を使ったMacではlaunchdもprocess終了後に再起動します。

## Agent tools

```bash
xangi tool remote_worker --action list
xangi tool remote_worker --action info --worker example-mac
xangi tool remote_worker --action usb-list --worker example-mac
xangi tool remote_worker --action exec --worker example-mac \
  --argv-json '["/usr/bin/git","status","--short"]' --cwd /Users/you/project
```

`info`は接続中workerが実際に読み込んでいる`workspaceRoots`と`allowedCommands`を`executionPolicy`として返します。token、Gateway URL、token/config file pathは返しません。設定変更後は`xangi worker restart`を実行し、`info`で反映を確認してください。

`exec`はworker側のworkspace rootとcommand allowlistを両方通った場合だけ実行されます。allowlistは完全一致で比較するため、実行ファイルの絶対pathを推奨します。shell command文字列、redirect、pipeはprotocolとして受け付けません。

## Linux / WSL2でのインストールと管理

Linux / WSL2では同じコマンドでsystemd user serviceを登録します。Node.js 22以上と、接続可能なsystemd user managerが必要です。`systemctl --user show-environment`で事前確認できます。

```bash
xangi worker install --pair 'xangi-pair://...' --workspace "$HOME/project"
xangi worker status
xangi worker restart
```

`install`は0600の認証情報と設定を`~/.config/xangi/worker/`へ保存し、`~/.config/systemd/user/xangi-worker.service`を作成してenable/startします（unitの配置は`XDG_CONFIG_HOME`に対応）。既存設定がある場合は上書きせず、`restart`または`uninstall`を案内します。`restart`は現在のCLIからunitを再生成し、認証情報を保持します。`start`・`stop`・`uninstall`も利用できます。`uninstall`はserviceを停止・無効化し、unitとworkerの設定・tokenだけを削除します。

`status`はActiveState・SubState・MainPIDを確認し、再試行中や失敗をrunningと区別します。Gatewayとの接続は`remote_worker --action list`で別途確認してください。ログは`journalctl --user -u xangi-worker.service -n 50`で確認できます。install途中でservice起動が失敗した場合も、保存済み認証情報は残るため、原因を解消して`restart`で再試行できます。

WSL2でsystemdが無効なら、既存の`/etc/wsl.conf`を保持しながら`[boot]`に`systemd=true`を設定し、PowerShellから`wsl --shutdown`してWSLを開き直してください。この操作は他のWSL作業も終了します。Ubuntu/Debianではsystemdとsystemd-sysvの導入も確認してください。user managerが使えない状態では、pairingを消費する前にエラーを返します。

これはWSL起動中のuser serviceです。Windows起動時のWSL自動起動やWSL自体の生存維持は設定しません。systemdサービスだけではWSLの生存は保証されません。WindowsネイティブのTask Scheduler対応も含みません。

参考: https://learn.microsoft.com/en-us/windows/wsl/systemd
