# macOS Computer Use

`computer.*` は [Cua Driver](https://github.com/trycua/cua) CLIを利用して、明示したmacOSのウィンドウを観測・操作する機能です。`browser.*` が使う独立Chromeプロファイルとは別です。通常のWeb操作は `browser.*`、スマートフォンは `mobile.*` を優先し、macOSアプリ、ネイティブダイアログ、通常Chromeのログイン済み画面が必要なときに `computer.*` を使います。

この機能は任意です。`pnpm setup --yes --disable computer` でツール一覧から外せます（既定ON）。OFFならCua Driverの導入・権限設定は不要です。詳細は[セットアップ](setup_ja.md)を参照してください。

## Mac側の準備

公式のCua Driver CLIをMacへインストールします。local-dev-mcpには同梱しません。既定の配置先以外にある場合は、サーバーの環境変数 `LOCAL_DEV_MCP_COMPUTER_DRIVER` に実行ファイルの絶対パスを指定します。

以下は**Macのローカル端末で**実行するコマンドです。

```bash
cua-driver --version
cua-driver serve
cua-driver permissions status --json
```

ドライバー本体にアクセシビリティ・画面収録権限がない場合は、ローカル端末で `cua-driver permissions grant` を実行し、macOSの許可操作を完了します。`computer.status` はドライバーの起動や権限プロンプトを発生させずに診断します。デーモン停止時の権限結果は呼び出し元プロセスの権限であることがあるため、起動後に再確認します。

## 操作の流れ

1. `computer.status` でインストール・起動・権限を確認する。
2. `computer.list_apps` / `computer.list_windows` で対象のPID・ウィンドウID・位置を確認する。
3. `computer.get_window_state` でアクセシビリティツリーと画像を取得する。画像だけなら `computer.screenshot` を使う。
4. 必要なら `computer.activate_window` で前面化し、`computer.click`、`computer.drag`、`computer.scroll`、`computer.type`、`computer.press_key`、`computer.hotkey` で操作する。
5. 操作後は画面を取り直して結果を確認する。ドライバーの成功応答だけで目的の操作完了と判断しない。

`computer.launch_app({bundle_id})` は指定アプリを起動します。続けて対象ウィンドウを列挙します。`browser.*` 失敗時に自動的にComputer Useへ切り替える動作はありません。

アクセシビリティ操作の `element_index` は、**同じ会話・作業コンテキスト**で直前に取得した `get_window_state` のものを使います。操作後や画像のみの取得後には無効になり、他のクライアントが同じドライバーの状態を更新した場合にも無効になり得るため、都度取得し直します。座標はmacOS画面全体の座標ではなく、**ウィンドウのスクリーンショット内のピクセル座標**です。`pid` と `window_id` を必ず指定します。

スクリーンショットは選択中のプロジェクトの `generated/local-dev-mcp/computer/` に0600権限で保存し、既存の `image.read` 経由で画像として返します。ユーザー向けのファイル添付とは別なので、ファイルを渡す場合は `artifact.link` を使います。

## 安全性

- 認証されたChatGPTの対話セッション、ClaudeまたはMuseの作業コンテキストと、登録済みプロジェクトが必要です。Museは毎回 `project_id`、Claudeは `context_id` を指定します。
- `computer.*` が操作できる範囲は**Mac上のデスクトップ全体**であり、project root内へのファイルアクセス制限ではありません。ウィンドウを変更する操作には選択中プロジェクトの `write_policy=allow` が必要です。`confirm` と `deny` では変更を拒否します。
- パスワード、ワンタイムコード、リカバリーコード、APIキーなどは `computer.type` で入力しません。秘密情報を含む画面をモデルへ取り込まず、Mac上で本人がログインを完了します。
- 送信、削除、購入、公開などの重要操作は対象と最終状態を確認してから実行します。結果が不明な操作は `action_applied=null`、`retry_action=false` を返すため、無確認で再実行しません。
- ドライバーのエラー文は入力内容が混入する可能性があるためそのまま返しません。`computer.type` の入力内容も結果に出力しません。
- ウィンドウ名やスクリーンショットには個人情報が含まれ得ます。信頼したMCPクライアントのみにアクセスを許可してください。
