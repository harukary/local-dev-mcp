# セットアップ

local-dev-mcp は登録した開発用PCを ChatGPT などから操作するセルフホスト型MCPサーバーです。基本機能だけなら Mobile / Computer / Browser / Repository Actions の外部ツールは不要です。

## 1. インストール

Node.js 22以降、pnpm、Gitを用意します。

```bash
git clone https://github.com/harukary/local-dev-mcp.git
cd local-dev-mcp
pnpm install
pnpm setup
pnpm doctor
```

`pnpm setup` では操作を許可するプロジェクトの場所・IDと、次のオプションを選択します。**初期値はすべてON**です。OFFにした機能はツール一覧に出ず、旧ツール呼び出しも拒否されます。

| オプション | 提供する機能 | 導入が必要になるもの |
| --- | --- | --- |
| Browser | `browser.*` | Google Chrome |
| Computer | `computer.*` | macOSと[Cua Driver](computer-automation_ja.md) |
| Mobile | `mobile.*` | [端末に応じたCLI・接続](mobile-automation.md) |
| Repository Actions | `repo.action.*` | 必要なリポジトリだけ `.local-dev/actions.json` |

オプションの利用をやめるためにChromeやCua Driverを削除する必要はありません。追加のMCPサーバーも必要ありません。

対話なしでセットアップする場合:

```bash
pnpm setup --yes
pnpm setup --yes --disable mobile,computer
pnpm setup --yes --enable computer
```

`--disable` / `--enable` は既存環境でも実行できます。指定しなかった項目の設定は維持します。初回に別のプロジェクトを登録する場合は `--project /absolute/path --id my-project` を指定します。2つ目以降のプロジェクトは `config/projects.local.yaml` に追記します。

設定ファイル:
- `.env`: 4機能のON/OFF。秘密情報や既存の環境変数は保持します。Git管理対象外です。
- `config/projects.local.yaml`: 操作対象のプロジェクト、パス、書き込みポリシー。初回だけ生成し、既存のファイルは上書きしません。

初回はこのリポジトリ自身をプロジェクトとして登録します。別の対象を操作する場合は登録先を変更してください。設定変更後はMCPサーバーを再起動します。ChatGPTで公開ツール一覧が変わった場合は既存アプリのアクション一覧もRefreshします。

## 2. 接続する

ローカルMCPクライアントで使う場合:

```bash
pnpm dev
```

ChatGPTで使う場合は、OpenAI Secure MCP Tunnelを使用します。

1. OpenAI PlatformでTunnelを作り、Tunnel ID・組織ID・runtime API keyをローカルの非公開ファイルに配置します。秘密情報の保存先は[READMEのTunnel設定](../README_ja.md#openai-secure-mcp-tunnel)を参照してください。
2. `pnpm tunnel:install` で公式Tunnelクライアントをインストールします。
3. `pnpm launchd:install` と `pnpm launchd:activate` でmacOSのMCPサーバーとTunnelを起動します。Businessのみの場合は両コマンドで `LOCAL_DEV_MCP_OPENAI_TUNNEL_PERSONAL_ENABLE=0 LOCAL_DEV_MCP_OPENAI_TUNNEL_BUSINESS_ENABLE=1` を指定します。
4. `pnpm tunnel:doctor` で接続状態を確認し、ChatGPTのDeveloper Modeで既存のTunnelへ接続します。

Claude・Museへの任意の接続はそれぞれ[Claudeの接続設定](claude-cloudflare-access.md)、[Museの接続設定](muse-tailscale-mcp.md)を参照してください。

## 3. 機能の有効化

機能をONにしただけでは、対応する外部CLIやOS権限のインストールは行いません。必要な機能だけ下記の個別ガイドに沿って準備してください。

- [Computer](computer-automation_ja.md)：Cua Driver CLIを導入し、macOSの許可を与える
- [Mobile](mobile-automation.md)：使用するiOS / Android端末に合わせて準備する
- [Browser](browser-runtime.md)：Chromeと隔離プロファイルの動作を確認する
- [Repository Actions](repo-actions.md)：リポジトリごとに実行できるアクションを宣言する

`pnpm doctor` はOFFの機能の依存ツールを診断対象から外します。ONの機能でツールが未インストールなら、対応する機能だけ利用できません。コアのMCPサーバーは引き続き使用できます。
