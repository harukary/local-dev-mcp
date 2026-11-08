# macOS Computer Use

`computer.*` はmacOSのアプリやウィンドウを操作する任意機能です。外部CLIの[Cua Driver](https://cua.ai/driver)を使用し、local-dev-mcp自身にはmacOS操作用の別MCPサーバーを追加しません。

Webの通常操作は `browser.*`、スマートフォンは `mobile.*` を使います。Computerはネイティブアプリ、OSのダイアログ、通常Chromeの既存ログイン状態を操作したい場合に使用します。Browserとはプロファイルも作業状態も別です。

## セットアップ

機能の既定値はONです。使わない場合は `pnpm setup --yes --disable computer` でツール一覧から非公開にできます。OFFならCua DriverのインストールもmacOS権限の付与も不要です。

使う場合はMac上で公式の安定版Cua Driver CLIを導入します。最新の公式インストーラーを確認してから実行してください。

```bash
curl -fsSL https://cua.ai/driver/install.sh -o /tmp/cua-driver-install.sh
# 内容を確認してから実行
bash /tmp/cua-driver-install.sh --no-connect --no-test --no-modify-path
cua-driver --version
```

`--no-connect` はCua Driverが他エージェントにMCPやSkillを自動追加するのを防ぎます。各OSSは直接CLIを呼ぶため、相互依存や専用MCPはありません。インストール後に `cua-driver permissions grant` をMacのローカル画面から実行し、表示されたAccessibilityとScreen Recordingの許可を完了します。

```bash
cua-driver permissions grant
cua-driver permissions status --json
open -n -g -a CuaDriver --args serve
cua-driver status
```

`permissions status` の `source.attribution` が `caller` の場合は呼び出し元の権限であり、CuaDriver本体の権限とは限りません。デーモン動作時の `daemon` 帰属を確認してください。特別なインストール先なら `LOCAL_DEV_MCP_COMPUTER_DRIVER` にCLI実行ファイルの絶対パスを指定します。

## 操作

1. `computer.status` で導入状態と権限を確認する。
2. `computer.list_windows` から対象の `pid` と `window_id` を確認する。
3. `computer.get_window_state` で画像とアクセシビリティツリーを取得する。画像のみなら `computer.screenshot` を使う。
4. 画像座標かツリーの要素トークンで操作し、再撮影して結果を確認する。

Cua Driverはアクセシビリティ要素を古い連番単体ではなく、`element_token` で識別します。`get_window_state` が返す `snapshot_id` とツリーの `[N]` を組み合わせた `<snapshot_id>:N` が識別子です。ツリーの再取得後は古いトークンを使いません。

local-dev-mcpは認証済み会話ごとに異なるCua Driverの `session` ラベルを使います。画面の観測と操作で同じラベルを使うことで、別会話の要素参照と混ざらないようにします。セッションラベル自体は認証情報ではありません。

座標操作では、**対象ウィンドウのスクリーンショット内のピクセル位置をそのまま指定します**。Cua DriverがRetinaスケールとmacOSの論理座標を内部変換します。画面全体の座標や手動の倍率計算は使用しません。

操作の既定はバックグラウンドです。操作が反映されなかったと確認できる場合だけ `delivery_mode=foreground` を指定します。`computer.activate_window` は明示的に前面表示が必要な場合だけ使います。

## 安全性

- 認証済みの対話コンテキストと登録プロジェクトを必要とします。画面を変更する操作にはそのプロジェクトの `write_policy=allow` が必要です。
- ウィンドウ操作はMac全体へ作用します。プロジェクトルート内のファイルだけに隔離されるわけではありません。
- `pid` と `window_id` を毎回検証し、操作には同じ会話内で取得した5分以内の画像・状態を要求します。
- 一度操作した画面の要素参照は失効します。別の変更操作の前には画面を再取得します。
- 操作結果の `effect` が `unverifiable` の場合、成功とみなさず画面を確認します。結果不明な変更操作は自動再送しません。
- Macが画面ロック・スリープ中の場合、ドライバーは画像を返せても `degraded=true` としてAX操作を止めます。Macを解除するまで入力を試みません。
- パスワード、OTP、APIキー等は入力・出力しません。機密画面の撮影も最小化してください。
- 画像は選択中のプロジェクトの `generated/local-dev-mcp/computer/` 以下へ権限0600で保存され、`image.read` を通してモデルへ返されます。ユーザーへの添付には別途 `artifact.link` を使用します。
