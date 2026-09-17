# local-dev-mcp Agent Notes

- 返答は、上位のユーザー指示が別言語を指定しない限り日本語で行う。
- このrepoの主なruntime clientはChatGPTであり、WebだけでなくChatGPT Androidからの実利用も互換性対象として扱う。

## ChatGPT transport

- ChatGPTとの正規接続経路はOpenAI Secure MCP Tunnelのみとする。public MCP ingressや別Tunnel方式の互換コードを追加しない。
- HTTP MCPはloopback bind + `X-Local-Dev-MCP-Tunnel-Token`を安全境界とし、tool/resource accessは原則`openai/subject` allowlistでfail-closedに制限する。ChatGPT Scheduled Taskで`openai/subject`が欠落する実測経路だけは、観測済みのexact metadata fingerprintに限定した互換例外を許可し、未知のanonymous request shapeは拒否する。stdio transportはlocal MCP client向けに独立して維持する。
- tool schemaやTunnel起動方式を変更した場合はunit testだけで完了扱いにせず、ChatGPT WebまたはAndroidで実tool callを確認する。
- ChatGPT Webで実tool callを促す検証では、通常は自然文で対象app名やtool目的を指定する。`@...` mentionを必須手順として扱わず、mention UI自体を検証する場合だけ使う。

## File and image transfer

- ユーザーへfileそのものを渡す場合は既定で`artifact.link`を使い、MCP `resource_link`だけをtool resultへ返す。file bytesを通常のtool historyへ埋め込まない。
- `artifact.read`はresource linkをclientが扱えない場合の互換fallbackに限定し、通常のsend/show/display/attachでは使わない。
- ChatGPTの通常添付をlocalへ受信する場合は`artifact.receive` + `openai/fileParams`を使い、base64 chunk loopを追加しない。
- 画像のmodel inspectionには`image.read`のinline MCP ImageContentを使う。public image URLやcustom image viewerを再導入しない。
- `artifact.link` / `artifact.read` / `artifact.receive` の変更は、ChatGPT Androidを含む実file transferでresource resolutionまたはbyte size/SHA-256をread-backして確認する。
