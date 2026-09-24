# local-dev-mcp Agent Notes

- 返答は、上位のユーザー指示が別言語を指定しない限り日本語で行う。
- このrepoの主なruntime clientはChatGPTであり、WebだけでなくChatGPT Androidからの実利用も互換性対象として扱う。

## ChatGPT transport

- ChatGPTとの正規接続経路はOpenAI Secure MCP Tunnelのみとする。public MCP ingressや別Tunnel方式の互換コードを追加しない。
- HTTP MCPはloopback bind + `X-Local-Dev-MCP-Tunnel-Token`を必須の安全境界とする。`openai/subject` allowlistは必要な利用者だけが有効化する追加の防御層で、未設定時はTunnel tokenのみで動作する。allowlist有効時はfail-closedに制限し、ChatGPT Scheduled Taskで`openai/subject`が欠落する実測経路だけ観測済みのexact metadata fingerprintに限定した互換例外を許可する。stdio transportはlocal MCP client向けに独立して維持する。
- tool schemaやTunnel起動方式を変更した場合はunit testだけで完了扱いにせず、ChatGPT WebまたはAndroidで実tool callを確認する。
- Business Workspaceの公開済みMCP Appでtool surfaceを変更した場合、このWorkspaceではまず既存Appのactionsをin-place Refreshし、actionsのread-back後にBranch chatまたは新規chatでmodel-facing schemaを再bindして確認する。tool変更だけを理由にAppを作り直さない。2026-09-20時点のOpenAI公式文書はBusinessの公開済みAppは再作成・再公開が必要とも記載しており実測と矛盾するため、この手順はWorkspace固有の観測ルールとして扱う。Refreshが利用不能・失敗・旧snapshotのままの場合だけ再作成へfallbackする。詳細は `docs/chatgpt-business-app-schema-refresh.md` を正本とする。
- ChatGPT Webで実tool callを促す検証では、通常は自然文で対象app名やtool目的を指定する。`@...` mentionを必須手順として扱わず、mention UI自体を検証する場合だけ使う。

## File and image transfer

- ユーザーへfileそのものを渡す場合は既定で`artifact.link`を使い、MCP `resource_link`だけをtool resultへ返す。file bytesを通常のtool historyへ埋め込まない。
- `artifact.read`はresource linkをclientが扱えない場合の互換fallbackに限定し、通常のsend/show/display/attachでは使わない。
- ChatGPTの通常添付をlocalへ受信する場合は`artifact.receive` + `openai/fileParams`を使い、base64 chunk loopを追加しない。
- 画像のmodel inspectionはまず`image.read`のinline MCP ImageContentを使い、成功する通常ケースでは`artifact.link`、chat attachment、download、materializeを中間経路にしない。ただし`image.read`が`IMAGE_TOO_LARGE`、inline imageなしの`preview_unavailable`、またはclient側inline image transport不調になった場合は、`artifact.link`からのresource materializationをinspection fallbackとして許可する。別processでraw bytesを処理する場合もmaterialize等のfile化を使う。public image URLやcustom image viewerを再導入しない。
- `artifact.link` / `artifact.read` / `artifact.receive` の変更は、ChatGPT Androidを含む実file transferでresource resolutionまたはbyte size/SHA-256をread-backして確認する。

## 大容量成果物の保管

素材の受け渡し、完成buildの保管、backup・復元、容量解放では共通 `gdrive` Skillを読む。 `gdrive/` が未導入なら共通Skillのsetup手順でaccount・project対応を確認して導入する。既存成果物の保存先は `docs/gdrive-migration-20260920.md` を参照。完成buildは検査後にDriveへ保管し、同期確認と原本削除は共通toolを使う。build commandへの自動組み込み有無は既存scriptで確認する。
他project由来のartifactは、その所有projectのDrive保存先を使う。
