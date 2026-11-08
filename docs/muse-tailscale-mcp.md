# MuseからTailscale経由でlocal-dev MCPを使う

## 接続構成

Muse Secure VMはMac上の既存local-dev MCPにTailscale経由で接続する。サーバーはローカルの`127.0.0.1:3456`だけで待ち受け、MacのTailscale Serveがtailnet内でHTTPSの10000番ポートを提供する。Funnelは使用しない。

```text
Muse Secure VM
  Python MCP client (integrations/muse/client.py)
  HTTPS CONNECT via Muse Tailscale TCP proxy :3130
    |
Tailscale tailnet (Grants / ACLs)
    |
Mac Tailscale Serve :10000 (private HTTPS)
    |
127.0.0.1:3456/mcp
    |
Muse Bearer auth -> Muse-only MCP tool profile
    |
registered projects / browser / mobile / shell / git / files
```

ChatGPTは従来のOpenAI Secure MCP Tunnel、ClaudeはCloudflare Access JWTを継続する。Museは独立したBearer tokenと独立したツール公開範囲を持つ。

## Mac側の設定

1. Tailscaleの`status --json`でMacのMagicDNS FQDN、`serve status --json`で既存443/8443番と10000番を確認する。
2. 専用tokenは`~/.local-dev-mcp/muse-token`のような公開しないファイルで管理する。初回作成時は`umask 077; openssl rand -hex 32 > ~/.local-dev-mcp/muse-token`。ファイル権限は0600にする。tokenの値はリポジトリ、chat、ログ、plistへ書き込まない。
3. Server LaunchAgentへ`LOCAL_DEV_MCP_MUSE_HOST=<MacのMagicDNS FQDN>:10000`と`LOCAL_DEV_MCP_MUSE_TOKEN_FILE=<tokenの絶対パス>`を設定する。既存Tunnel用の環境変数を保持して`pnpm launchd:activate`を使い、手動で個別Agentを再起動しない。
4. Macの`/Applications/Tailscale.app/Contents/MacOS/Tailscale serve --bg --https=10000 http://127.0.0.1:3456`で専用Serveを構成する。既存Serveのルートは削除・変更しない。
5. 必要に応じTailscale Grants/ACLsでMuseノードからMacのTCP 10000を許可する。既存の広い許可がある場合、追加のGrantsだけでは制限されない。Funnelを有効化しない。

Muse用Hostは完全一致で`/mcp`だけを許可し、Bearer tokenが必須。Muse HostにOpenAI Tunnel tokenやCloudflare Access JWTを混在させない。tokenファイルが欠落・不正・権限過大の場合は起動時に拒否する。

## Muse Secure VM側

`integrations/muse/client.py`はPython標準ライブラリだけを使用する、1回のコマンドにつき1回のMCP初期化・ツール呼び出しを行うクライアント。Museのカスタム連携や再利用可能な手順から起動する。リポジトリ内のコードをMuse VMへ配置する必要がある。

- `LOCAL_DEV_MCP_URL=https://<MacのMagicDNS FQDN>:10000/mcp` を設定する。
- Muse実行環境の`HTTPS_PROXY`をそのまま使う。クライアントは認証情報付きプロキシホストを維持してポートを3130に変更する。動的認証情報を長期保存しない。
- `LOCAL_DEV_MCP_MUSE_TOKEN`には安全な認証情報管理機構からtokenを実行時に渡す。通常のチャット、Skill本文、Git、平文workspaceファイルへ保存しない。Muse環境で安全な注入方式が使えない場合は接続を強行しない。

コマンド例：

```sh
python3 client.py projects
python3 client.py tools --filter workspace.
python3 client.py schema workspace.read
python3 client.py call project.open '{"project_id":"local-dev-mcp"}'
python3 client.py call workspace.read '{"project_id":"local-dev-mcp","path":"README.md"}'
python3 client.py call workspace.batch '{"project_id":"local-dev-mcp","requests":[{"tool":"workspace.read","arguments":{"path":"README.md"}},{"tool":"workspace.list","arguments":{"path":"docs","max_entries":10}}]}'
```

`workspace.batch`の子要素は`tool`と`arguments`の組で指定する。子操作は同じproject/worktreeスコープで実行される。

## Museのツール契約

- `project.list`で登録済みprojectを確認し、`project.open({project_id,working_dir?})`で共通・project固有のAGENTS.mdを読み取る。状態を永続的に選択する`context_id`は使わない。
- `workspace.*`、`git.*`、`repo.action.*`、`shell.run/status/cancel`、`browser.*`、`mobile.*`などのproject操作は、毎回`project_id`を指定する。worktreeでは`working_dir`も同じ値に揃える。
- Browser profileと非同期Shell jobの所有権は、認証主体・project・working_dirから作る非公開の`muse-work:`内部識別子で分離する。Browser profileは同じ作業スコープの連続操作で再利用できるが、同一projectの複数の並行ブラウザ作業は避ける。
- `project.select/current/reload`、`shell.approve/reject/pending`、`artifact.link/receive`はMuseに公開せず、ツール名を直接指定しても`TOOL_UNAVAILABLE`で拒否する。MCP resources/list/readもMuseでは無効。
- 認証済みMuseの操作も、登録project制限、denied paths、Shellのリスク分類、既存の書き込みポリシーを引き続き受ける。`write_policy=allow`かつ`approval_mode=policy`なら、単一ファイルの`mv`や`rm`は承認なしで実行できる。再帰削除・強制リセットなどは承認対象となる。
- Museには承認ツールがない。承認が必要な`shell.run`は`APPROVAL_UNAVAILABLE`を返し、承認要求を作成しない。認証情報を注入する`credential_scope`も、通常の書き込み許可とは別に必ず承認が必要なためMuseでは利用できない。
- `write_policy=deny`は`workspace.patch`の書き込みとShell書き込みを拒否する。`write_policy=confirm`でも、ファイル内容を厳密に指定する`workspace.patch`は利用できるが、Shell書き込みは承認対象になる。`workspace.patch`の`dry_run`は書き込み禁止プロジェクトでも利用できる。
- Host Sandboxはプロジェクトのパスを作業ディレクトリにするだけで、OSレベルでファイルシステムを隔離しない。Shellのdenied paths・危険度分類はコマンド文字列の検査であり、厳密な安全境界ではない。`write_policy=allow`は接続クライアントへのShell実行権限の委譲を意味する。
- 成功した`workspace.read/search/list/batch`、`skills.read`、`project.open`などの結果は重複JSONを除いたテキスト中心。行番号、継続情報、エラーを保持する。

## 画像・artifactの取得

MCPサーバーは`image.read`で`ImageContent`、`artifact.read`でBase64の埋め込みresourceを返す。MuseクライアントはMCPの返却内容を自動で画面に表示できないため、`--output`でMuse VM上の新しいファイルへ保存する。

```sh
python3 client.py call image.read '{"project_id":"local-dev-mcp","path":"docs/local-dev-mcp-system-overview-ja.png","mode":"preview"}' --output /path/to/new-preview.png
python3 client.py call artifact.read '{"project_id":"local-dev-mcp","path":"README.md"}' --output /path/to/new-readme.md
```

`--output`は保存先が新規ファイルの場合だけ動作する。既存ファイルやsymlinkは上書きせず、mode 0600で保存する。最大6 MiB、Base64検証あり。バイナリ本体を標準出力に混ぜない。画像を視覚的に確認するには、保存したファイルをMuseの利用可能な画像表示機能で開く必要がある。保存だけでMuseのモデルが画像を視認できたとはみなさない。

`artifact.link`は非公開なので`artifact.read`を使う。`mode=metadata`の`image.read`は画像本体を返さないため、`--output`を使うとエラーになる。MCPリソースリンクのみのレスポンスは保存対象外。

## 確認項目

- Bearerなし・不正tokenは401、Muse Host以外は403。正しいMuse認証ではHTTPSの`initialize`と`tools/list`ができる。
- `project.open`、`workspace.read`、`git.inspect`が利用でき、`project_id`なしのproject操作が拒否される。
- Museで非公開のツールは直接MCP`tools/call`を送っても`TOOL_UNAVAILABLE`になり、状態を変更しない。
- `browser.status`は`BROWSER_CHAT_ID_UNAVAILABLE`にならず、別project/worktreeのブラウザ所有権は混ざらない。
- 画像・artifactを`--output`で保存でき、既存ファイルを保護する。
- ChatGPT・Claudeの既存スキーマ、認証、ブラウザ状態への互換性を維持する。

コードの自動テストは`pnpm test`、`pnpm typecheck`、`python3 -m unittest discover -s integrations/muse -p 'test_*.py'`で実行できる。

## 参考

- [Meta: How We Built Safety Into Muse](https://research.meta.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse)
- [Tailscale: Muse integration](https://tailscale.com/blog/meta-muse-ai-agent-tailscale)
- [Tailscale: Serve](https://tailscale.com/docs/reference/tailscale-cli/serve)
- [Tailscale: access control](https://tailscale.com/docs/features/access-control)
