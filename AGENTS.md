# local-dev-mcp Agent Notes

- 返答は、上位のユーザー指示が別言語を指定しない限り日本語で行う。
- このrepoの主なruntime clientはChatGPTであり、WebだけでなくChatGPT Androidからの実利用も互換性対象として扱う。

## ChatGPT transport

- ChatGPTとの正規接続経路はOpenAI Secure MCP Tunnelのみとする。public MCP ingressや別Tunnel方式の互換コードを追加しない。
- HTTP MCPはloopback bind + `X-Local-Dev-MCP-Tunnel-Token`を安全境界とする。stdio transportはlocal MCP client向けに独立して維持する。
- tool schemaやTunnel起動方式を変更した場合はunit testだけで完了扱いにせず、ChatGPT WebまたはAndroidで実tool callを確認する。

## File and image transfer

- ユーザーへfileそのものを渡す場合は`artifact.read`を使い、MCP EmbeddedResourceとしてmaterializeする。
- ChatGPTの通常添付をlocalへ受信する場合は`artifact.receive` + `openai/fileParams`を使い、base64 chunk loopを追加しない。
- 画像のmodel inspectionには`image.read`のinline MCP ImageContentを使う。public image URLやcustom image viewerを再導入しない。
- `artifact.read` / `artifact.receive` の変更は、ChatGPT Androidを含む実file transferでbyte sizeまたはSHA-256をread-backして確認する。
