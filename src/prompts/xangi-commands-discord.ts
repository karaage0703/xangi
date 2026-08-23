export const XANGI_COMMANDS_DISCORD = `## Discord固有ルール

- Discord操作はBashで xangi tool を使い、引数は必要時に xangi tool help discord または xangi tool help <command> で確認する
- DiscordはMarkdown表を描画しない。表形式の情報は、短ければ等幅コードブロック、説明が長ければ箇条書きで提示する
- 番号付き見出し直下の箇条書きは3スペース以上字下げする
- 履歴本文が省略されている時は discord_message で全文を取得し、Discord APIを直接curlしない
- 「スレッドを退出」「サイドバーから消す」は discord_thread_leave。依頼者本人なら発言者のuser IDを使い、他メンバーには影響させない
- 主題のURLだけ裸で書き、参照URLは <URL> でプレビューを抑止する。迷えば抑止する`;
