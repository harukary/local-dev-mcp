# MuseからTailscale経由でlocal-dev MCPに接続する

## 構成

Meta MuseのSecure VMから、Macで稼働する既存のlocal-dev MCPを利用する。Tailscaleは**MuseからMacへのプライベートTCP経路**として使い、ChatGPTのOpenAI Secure MCP TunnelとClaudeのCloudflare Accessを変更しない。

```text
Muse Secure VM
  integrations/muse/client.py  (one-shot MCP JSON-RPC client)
  HTTPS_PROXY host :3130       (Muse's Tailscale TCP proxy)
       |
Tailscale tailnet (Grants/ACLs)
       |
Mac Tailscale Serve :10000 (tailnet-only HTTPS)
       |
127.0.0.1:3456/mcp  (existing local-dev MCP)
       |
Muse Bearer authentication -> Muse tool profile
       |
shared project registry / workspace / git / shell / browser / mobile
```

MCPサーバー自体は従来どおり`127.0.0.1`にのみbindする。Muse用URLは`https://<MacのMagicDNS FQDN>:10000/mcp`。Tailscale Funnelは使わない。

## Macへの設定

1. Macの`tailscale status`でTailscaleの参加状態とMagicDNS FQDNを確認する。既存Serveは`tailscale serve status --json`で確認し、使用中の443/8443や他サービスを変更しない。
2. Muse専用に32バイト以上のランダムなtokenを作り、非公開のmode 0600ファイルに保存する。例えば`umask 077; openssl rand -hex 32 > ~/.local-dev-mcp/muse-token`。**tokenの値をチャット・ログ・リポジトリ・LaunchAgentへ書かない。**
3. `LOCAL_DEV_MCP_MUSE_HOST`には正確な`<MacのMagicDNS FQDN>:10000`、`LOCAL_DEV_MCP_MUSE_TOKEN_FILE`にはtokenファイルの絶対パスを指定する。片方だけの設定、弱いtoken、権限の緩いファイルは起動時に拒否する。
4. 既存のOpenAI Personal/Business Tunnel、Cloudflare Access/Tunnelの有効設定を保持したまま、`scripts/install-launchd.sh --activate`でServer LaunchAgentへ設定を反映する。Muse用envは非秘密のHostとtokenファイルパスだけをplistへ格納する。
5. `/Applications/Tailscale.app/Contents/MacOS/Tailscale serve --bg --https=10000 http://127.0.0.1:3456`で専用Serveを追加する。設定後、`tailscale serve status --json`で既存ルートと10000の両方を検証する。Serveは再起動後も継続する。

Muse用Hostは厳密なDNS FQDNとポートに一致する場合だけ受け付ける。そのHostに来たリクエストは`/mcp`だけ許可し、`Authorization: Bearer <token>`が必須。Muse Host上ではChatGPT Tunnel tokenやCloudflare Access JWTを使用できない。localhost Host上の従来の認証フローは変更しない。

### Tailnetのアクセス権

TailscaleのGrants/ACLsでMuseノードからMacのTCP 10000だけを許可する。既存のGrantsやACLsは許可の和集合となるため、許可を追加するだけでは以前の広い許可を削れない。現在の全ポリシーを確認してから必要な範囲だけ編集する。Museノードは外向き通信だけを行い、最初の接続先への許可をMuseが要求することがある。

Grantsの例（既存のポリシーへ併合し、アドレスは実値へ置換）：

```json
{
  "grants": [
    {
      "src": ["<Muse node's Tailscale IP>"],
      "dst": ["<Mac's Tailscale IP>"],
      "ip": ["tcp:10000"]
    }
  ]
}
```

## Muse VM側の接続

`integrations/muse/client.py`はPython標準ライブラリのみを使用したMCP Streamable HTTPの最小クライアント。VMへ`client.py`を配置し、Museのカスタム連携から呼び出す。Muse Codeの`mcp_servers`設定とは別物であり、個人向けMuse Secure VMの実行環境を対象としている。

必要な非秘密環境変数：

- `LOCAL_DEV_MCP_URL=https://<MacのMagicDNS FQDN>:10000/mcp`
- `HTTPS_PROXY`はMuse実行環境の値をそのまま使う。クライアントはホストと都度更新される資格情報を保持し、ポートだけ3130へ変更する。

必要な秘密環境変数：

- `LOCAL_DEV_MCP_MUSE_TOKEN`: Museの認証済みカスタム連携から実行時に注入する。通常のチャット入力やリポジトリへ値を置かない。Museの`hatch-authd`は認証情報を分離して管理するが、任意のカスタムCLIへのsecret環境変数注入が利用可能かはMuse環境で確認する。利用できない場合、平文のworkspaceファイルへの保存や公開トンネルへの切替はしない。

```sh
python3 client.py projects
python3 client.py tools --filter workspace.
python3 client.py schema workspace.read
python3 client.py call project.open '{"project_id":"local-dev-mcp"}'
python3 client.py call workspace.read '{"project_id":"local-dev-mcp","path":"README.md"}'
```

通信はHTTP CONNECTプロキシを明示指定する。外部インターネットへ自動フォールバックしない。送信元Muse VMで初回アクセス承認が発生した場合、重複リクエストしない。MCPの`initialize`と`tools/list/call`を呼び、JSON/SSEを読んでテキストを出力する。メディアをこのCLIから直接表示できるとはみなさない。

## MuseのMCPツール契約

Museは他クライアントと同じツール実装を使うが、認証済みの`ClientToolProfile=muse`を通じて専用スキーマを受け取る。

- `project.list`は登録済みプロジェクト一覧を返す。
- `project.open({project_id,working_dir?})`は共通・projectローカルのAGENTS.mdを読み、選択状態を保存しない。
- `workspace.*`、`git.*`、`repo.action.*`、`browser.*`、`mobile.*`、`shell.run/status/cancel`など、プロジェクトを操作するツールは`project_id`が必須。`working_dir`は省略時にproject rootで、worktreeでは各呼び出しで同じ値を渡す。
- 会話別の`context_id`を作成・保持せず、共有の選択中プロジェクトも持たない。Muse用の内部所有者は認証主体とproject/working_dirから導出する。この単位でBrowser stateや非同期Shellジョブの所有権を分離する。
- `project.select/current/reload`、`shell.approve/reject/pending`、ChatGPT専用`artifact.receive/link`はMuseへ公開しない。MCP resources/readも無効。
- `workspace.read/search/list/batch`、`skills.read`、`project.open`の成功結果は、行番号・継続カーソル・instructionsを維持しつつ不要な重複JSONを除いたテキストへ整形する。エラー・メディア・未知の結果形状は勝手に省略しない。
- 同一projectのBrowser等、状態を共有する操作を複数タスクから並行させない。重いビルドは既存Pueue手順に従う。

## 動作検証

- Mac上で`curl --resolve`等によりHostを指定してローカルHTTPへアクセスし、不正Hostの403、Muse Host上での不正Bearerの401、正しいBearerでのMCP `initialize`/ツール呼び出しを確認する。secretの値はコマンド表示・ログへ出さない。
- Tailscale Serveで10000のtailnet-only公開と既存443/8443の維持を確認し、Muse VMのポート3130プロキシ経由でHTTPS POSTを試す。pingの成功・失敗はTCP到達性の判定に使わない。
- `project.open`、`workspace.read`、`git.inspect`、短い書き込み、非同期Shellの起動/状態取得/停止を確認する。別project/worktreeのジョブ参照は拒否される。
- ChatGPTから実ツール呼び出し、Claudeから実ツール呼び出しを行い、旧ツール契約と認証を維持していることを確認する。

Muse側の秘密値注入方式または初回のアクセス承認が使えない場合は、Macサーバーの接続準備が完了していても**Muse実接続は未検証**と扱う。

## 参考

- [Meta: How We Built Safety Into Muse](https://research.meta.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse)
- [Tailscale: Muse integration](https://tailscale.com/blog/meta-muse-ai-agent-tailscale)
- [Tailscale: Serve](https://tailscale.com/docs/reference/tailscale-cli/serve)
- [Tailscale: access control](https://tailscale.com/docs/features/access-control)
- [Muse Tailscale proxy notes (third-party mirror)](https://github.com/win4r/MuseAI-Skills/blob/main/home/hatch/docs/devices/tailscale.md)
