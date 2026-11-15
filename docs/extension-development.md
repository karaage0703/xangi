[English](en/extension-development.md) | 日本語

# 拡張機能の設計思想と開発ガイド

このガイドは、AIと協働してxangiの拡張機能を作るためのものです。設計・実装言語・テンプレートは用途に合わせて選び、利用者の希望を優先します。manifest・readiness・認証などの接続仕様は、実装に合わせます。

## 拡張機能とは

拡張機能は、専用の画面・データ操作・機器接続などをxangiへ追加するソフトウェアです。managed HTTP方式では、manifestで入口を宣言し、本体が別プロセスを起動して画面やAPIへ中継します。

- **スキル**は、AIが読む手順や判断基準です。既存ツールで目的を達成できる場合に使います。
- **拡張機能**は、専用APIや継続して動くサービスが必要な場合に使います。操作手順をスキルとして同梱できます。
- **通常のアプリ**も、接続用の入口を追加すれば拡張として使えます。登録すると本体の起動管理・診断・認証付き中継を利用できます。

画面、AI、デバイス、データ管理、外部サービス、継続処理は必要に応じて組み合わせます。例えば読書メモなら画面と保存、センサーなら機器接続と収集処理から始められます。

## AIと開発する手順

### 開発コマンドによる入口

利用者が作りたい機能を伝え、会話中のAIが`extension create`の出力を読んで開発を進めます。このコマンドは開発ガイドとテンプレートの公開先を返し、ファイル作成や別AIの起動は行いません。`--help`は使い方だけを表示します。開発repoではローカルテンプレートのpathとREADMEも表示します。

### テンプレートから作成する

新規拡張は、指定されたテンプレートか公開テンプレートの最新版を使います。AIがREADMEとsetup手順を読み、取得・設定・検証を行います。GitHub上のrepo作成が依頼に含まれる場合は次のCLIを使い、OWNER・名前・公開範囲を依頼に合わせます。

```sh
gh repo create OWNER/my-extension --template karaage0703/xangi-extension-template --private --clone
cd my-extension
npm ci
npm run configure -- --id my-extension --name "My extension" --features ui
npm test
npm run build
```

ローカルだけなら、テンプレートを別の作業ディレクトリへコピーします。共通の設定・起動・認証・更新準備・文書を使い、業務機能を追加します。既存拡張はそのプロジェクトで作業します。

テンプレートはNode.js標準ライブラリによる参照例です。機能は`ui,device,ai`から選び、既定は画面のみ、`none`で全て無効にできます。設定からmanifestを生成します。デバイス例は認証付きメッセージ入口で、実機SDK・`agentBackend`・入力欄UIは別途実装します。

### 実装と検証

1. 最初の入力と結果、対象外、成功条件を決め、既存コード・docs・tests・設定を調べます。[本体の設計](design.md)と対象拡張のREADME・setup文書も確認します。
2. 対象repoとbranchを決め、既存の未コミット変更から作業を分離します。
3. manifest、entrypoint、API、必要なUIと文書を実装し、テンプレートとの差分と設定・manifestの整合を確認します。
4. [Extension連携](usage.md#extension連携)と対象instanceの絶対CLIのhelpを確認し、依頼範囲で登録・対象IDの起動・`status`・`doctor`を実行します。
5. 代表操作のAPI結果・画面・保存データを確認し、変更に応じて失敗・timeout・取消・再起動後の保持を検証します。
6. 差分・検証結果・未確認・互換性・データへの影響を報告します。公開や外部送信は、許可された範囲で行います。

### 文書を用途へ合わせる

拡張のREADMEには機能・開始手順・詳細資料へのリンクを書きます。共通の接続仕様は本体の文書を参照し、個別の設定・操作・保存データは拡張repoで管理します。日英版は内容と構成を揃えます。

| 内容               | 日本語           | 英語                |
| ------------------ | ---------------- | ------------------- |
| 機能・開始手順     | `README.md`      | `README.en.md`      |
| AI向けセットアップ | `XANGI_SETUP.md` | `XANGI_SETUP.en.md` |
| 設定・使い方・検証 | `docs/usage.md`  | `docs/en/usage.md`  |
| 構成・認証・保存   | `docs/design.md` | `docs/en/design.md` |

これはテンプレートの構成です。既存拡張ではそのプロジェクトの文書構成に合わせます。

## 本体・拡張・skillの責任

| 担当            | 役割                                              |
| --------------- | ------------------------------------------------- |
| xangi本体       | 会話・担当AI・実行状態・拡張の起動管理・共通proxy |
| 拡張            | 業務データ・API・専用画面・処理・機器接続         |
| skill           | AIが参照する作業手順・判断基準・ツールの使い方    |
| 利用先workspace | 利用者固有のルール・保存先・連携設定              |

- 画面と会話で同じデータを扱えるよう、安定したIDとAPIを用意します。
- 保存・検証・状態更新はコードで行い、意図の解釈や文章作成はAIへ任せます。
- 新しい仕組みを作る前に、本体・既存拡張・skillを検索します。
- 起動・準備完了・生成・保存・外部送信を区別し、確認した結果を報告します。
- 個人のpath・host・認証値・会話ID・非公開データを配布物へ含めません。

## AI実行の方針

指定がなければ本体経由を基本に検討します。会話の継続と仕事単位の依頼を区別し、用途に合う既存APIを使います。担当AI・実行先・結果・失敗・timeout・取消方法と、取得できる履歴・利用量を説明します。

担当は拡張で明示選択した値、未設定なら本体が解決した既定担当を使い、画面に実効値を表示します。本体の選択規則を複製したり、他の拡張の担当を暗黙に借りたりせず、解決できなければ設定の問題を知らせます。

通常の接続先は親instanceです。別instanceへの接続やAIへの直接接続は明示設定とし、送信先・認証・timeout・取消方法、および本体の停止・監視・履歴・利用量記録が適用される範囲を示します。backendが返さない利用量は補完しません。既存拡張の移行では、実行経路・担当・接続先の設定を確認して保持します。

## 現行のmanaged HTTP接続仕様（実装の参照）

### Manifest

repo rootの`xangi-extension.json`に相対entrypoint、runtime、HTTP capabilityを宣言します。対応するスクリプトとHTTPサービスも実装します。

```json
{
  "schemaVersion": 2,
  "id": "example-extension",
  "displayName": "Example extension",
  "version": "0.1.0",
  "entrypoint": "scripts/xangi-extension",
  "runtime": { "kind": "managed-http" },
  "setup": { "instructions": "XANGI_SETUP.md" },
  "capabilities": [{ "id": "example.manage", "protocol": "http", "healthPath": "/health" }],
  "ui": { "capability": "example.manage", "path": "/ui" }
}
```

`setup`と`ui`は任意です。宣言と検証条件は`ExtensionManifest`と`parseExtensionManifest()`を参照してください。

### 起動・状態・終了

1. 本体はentrypointを`serve --workspace <path>`で起動し、`XANGI_EXTENSION_AUTH_TOKEN`を渡します。
2. 拡張は`127.0.0.1`の自動割当portで待ち受け、受信requestのBearerを確認します。
3. readiness JSONを標準出力へ1行で返し、診断ログは標準エラーへ出します。workspaceとURLは実際の値を使います。
4. stdin切断・SIGTERM・SIGINTでサービスと処理を終了します。

```json
{
  "schemaVersion": 2,
  "event": "ready",
  "id": "example-extension",
  "workspace": "/absolute/path/to/workspace",
  "baseUrl": "http://127.0.0.1:12345"
}
```

本体はID・workspace・loopback URLを検証し、`running`・`healthy`・`ready`を区別します。cold startのhealth確認が未完了でも、readiness検証済みのprocessを直ちに起動失敗にはしません。詳細は[Extension連携](usage.md#extension連携)を参照してください。

親から`XANGI_EXTENSION_INSTANCE_ID`を受け取ります。Web Chat有効時は`XANGI_EXTENSION_HOST_URL`、イベント配信有効時は`XANGI_EXTENSION_EVENTS_URL`も渡されます。親のURLやportを推測せず、渡された値を使います。

### 画面・認証・信頼境界

UI入口は`/api/extensions/<id>/ui`、サービス入口は`/api/extensions/<id>/service/`です。asset・API・WebSocketは本体配下で動く相対URLにします。proxyの認証・Cookie・リダイレクト・制限は[Extension連携](usage.md#extension連携)を参照してください。

共通ホーム・戻る/進む・テーマ連動は[拡張UI開発ガイド](extension-ui.md)を参考にし、拡張には業務操作を置きます。本体の戻る/進むはiframeを含むブラウザ履歴を扱います。保存前確認などが必要な独自ナビは拡張側で用意できます。

拡張サービス用Bearerと本体API用認証は別です。サービス用tokenを本体APIへ流用したり、browser・manifest・ログへ公開したりしません。

拡張は信頼したローカルコードを実行し、managed起動では親の環境変数を引き継ぎます。`permissions`は説明用の宣言であり、別processやiframeも含め、OSによる権限隔離を保証しません。

### セットアップ・データ・更新

setup文書には接続先、保存先、AI担当、任意機能、検証方法を記載します。同梱skillは利用先workspaceの規則に合わせ、同名の既存skillと比較して配置します。

永続データは更新で差し替えるsourceの外へ置き、workspace/instanceの保存単位、保存先の解決方法、バックアップと復元、更新・登録解除後の保持を説明します。保存先は拡張ごとに確認します。

repositoryからの更新には`update.prepare`と対応するsource管理状態が必要です。準備処理はprogramと引数に分け、更新後は`doctor`とデータ保持を確認します。source更新・workspaceのskill更新・登録解除・データ削除は別の操作として扱います。更新と復旧の詳細は[Extension連携](usage.md#extension連携)を参照してください。

## AI主導の設定・カスタマイズ・移行

AIは利用者の目的と好みに合わせ、調査・設定・移行・起動・検証・復旧を担当します。既存の依頼から決められることは進め、不明な目的や範囲外の変更を確認します。

設定には意味・既定値・許容値・反映時期・保存単位を示し、実効値を確認できるようにします。利用者の好みは利用先の設定へ保存し、汎用既定値や別instanceへ混入させません。秘密情報は既存の保存機構や環境変数を使い、報告へ実値を出しません。

データ移行では、既存API/CLIやコピー・変換から適切な手段を選び、次を確認します。

- 所有者・保存単位・移行元・移行先と、移行前のバックアップ・復元手順。
- 内容・ID・参照関係・設定・好みの保持と、形式変更時の対応関係。
- 件数・内容・参照の照合、再取得、代表操作、再起動後の保持。

空データでの起動や`doctor`成功だけで移行完了とはせず、照合が終わるまで原本と復元経路を残します。

## 互換性の確認

拡張のsetup文書に、必要な本体機能・API、確認した本体版、未確認範囲を記載します。単体テストやmockと実機確認を区別します。manifestの`schemaVersion`は形式の版であり、現行manifestに本体の対応version範囲を機械判定する共通項目はありません。

## 実装を確認する場所

- [manifest・managed runtime](../src/extensions.ts): 型、パーサ、readiness、状態、process管理。
- [サービスproxy](../src/extension-web-proxy.ts)と[画面](../web-ui/src/ExtensionView.tsx): 認証付き中継と本体内の表示。
- [catalog・setup・削除](../src/extension-catalog.ts)、[repository取得](../src/extension-repository.ts)、[更新](../src/extension-update.ts): 取得・導入・保持・復旧。
- [AI依頼経路](../src/web-chat.ts): 会話とagent runのAPI。
- [runtimeのtests](../tests/extensions.test.ts)、[proxyのtests](../tests/extension-web-proxy.test.ts)、[更新のtests](../tests/extension-update.test.ts): 契約と失敗時の動作。
