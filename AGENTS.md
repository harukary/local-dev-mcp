# local-dev-mcp Agent Notes

- 返答は、上位のユーザー指示が別言語を指定しない限り日本語で行う。
- このrepoの主なruntime clientはChatGPTであり、WebだけでなくChatGPT Androidからの実利用も互換性対象として扱う。

## MCP image viewer

- `image.show` の画像ビューアは、ChatGPT Androidで確認済みのlegacy Skybridge経路を維持する。
- `src/mcp/resources/image-viewer.ts` のviewer resourceを変更するときは、`text/html+skybridge` MIME、`ui://local-dev-mcp/image-viewer-skybridge-*.html` 系URI、legacy `window.openai` / `ui/notifications/tool-result` 経路を互換性契約として扱う。
- `text/html;profile=mcp-app`、MCP Apps `ui/initialize` / `ui/notifications/initialized` handshake、またはviewer visibility metadataへ切り替える場合は、unit testだけで完了扱いにせず、ChatGPT Androidで新しい `image.show` cardの画像表示とBranch chatを実操作で確認する。
- 画像表示不具合の調査では、tool実行成功、resource取得、viewer内の画像データ受信、ChatGPT Android card描画、Branch chat遷移を別々の層として切り分ける。既存conversationの古いcardはviewer URIやclient cacheの影響を受けうるため、新規 `image.show` 実行での確認を優先する。
