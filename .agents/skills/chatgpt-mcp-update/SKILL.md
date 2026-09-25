---
name: chatgpt-mcp-update
description: local-dev-mcp の MCP tool schema、tool description/input schema、Secure Tunnel、LaunchAgent、ChatGPT Business Workspace Plugin への反映を変更・検証するときに使う repo-local Skill。runtime 更新から Workspace actions Refresh、snapshot read-back、Branch/new chat での model-facing schema rebind までを一連で扱う。Plugin package の Version bump や USER版の二重登録を schema Refresh の代替にしない。
---

# chatgpt-mcp-update

## 基本モデル

ChatGPT への反映は4層として扱う。

```text
repository source
  -> running local-dev-mcp runtime
    -> Business Workspace Plugin action snapshot
      -> conversation / branch tool binding
```

各層は独立に古くなり得る。上流が新しくても下流が自動更新されたと仮定しない。

実測の背景・例外・履歴は `docs/chatgpt-business-app-schema-refresh.md` を読む。

## 更新手順

1. `git.inspect` で branch / upstream / dirty state を確認する。
2. model-facing tool contract が変わるか判定する。
   - tool名
   - description
   - input schema
   - tool追加/削除
   - ChatGPTに見せるinstructions
3. 実装し、関連test・typecheck・buildを通す。
4. public tool contract が変わった場合は `TOOL_SCHEMA_VERSION` を更新する。
5. runtimeへ反映する。
   - 通常のserver変更は正規のLaunchAgent経路を使う。
   - server/Tunnel/LaunchAgent変更を含む場合は `LOCAL_DEV_MCP_OPENAI_TUNNEL_BUSINESS_ENABLE=1 pnpm launchd:activate` を使う。
   - MCP自身からactivateしてもone-shot handoffで復旧する現在の実装を前提にし、個別jobを場当たり的にbootout/bootstrapしない。
6. runtimeを直接read-backする。
   - `tool.schema` でschema versionと変更対象を確認する。
   - `/healthz` とBusiness Tunnelの疎通を確認する。
7. 既存のBusiness Workspace Pluginのactionsを **in-place Refresh** する。
   - 既存Appをtool変更だけで作り直さない。
   - USER版を追加して二重登録しない。
   - Workspace側の `Allow all tools` / `All enabled` / `Enable all new tools` を維持する。
8. Refresh後のWorkspace action snapshotをread-backする。
   - 変更したdescription/input/tool名のうち、最低1つをsentinelとして新旧を比較する。
   - snapshotが新しくなるまでBranchへ進まない。
9. **Branch chat** または完全な新規chatを作る。
   - Refresh済みでも既存conversationのtool bindingはhot-swapされない。
10. Branch/new chatでmodel-facing schemaを確認する。
    - `ALL_TOOLS` 相当のtool定義、または実際に見えるinput schema/descriptionを確認する。
    - `tool.schema` のversionも確認する。
11. harmlessな実tool callを1回通し、更新完了とする。

Git pushが必要な運用では、`shell.run` の `git push` より typed `git.push` を優先する。`git.push` は現在branchの設定済みupstreamだけを対象にし、`expected_head`一致、behind拒否、force/tag/delete禁止、remote HEAD read-backを行う。特にScheduled Taskではこの狭いtool surfaceを使い、汎用shell経由の外部mutationを避ける。

## Refresh UIが見えない場合

新しい `Admin -> Plugins` UIにRefreshが見えなくても、Refresh機能そのものが消えたと即断しない。

1. まず既存AppのWorkspace action snapshotが本当に古いか確認する。
2. `Admin -> Apps` 系の現在のapp-management clientにaction Refresh flowが残っているか確認する。
3. UI導線が消えている場合は、**その時点のChatGPT自身のclient実装が使うRefresh flowを再確認してから**実行する。
4. connector link IDや内部endpoint名をSkillへ固定値として埋め込まない。UI/client internalsは変更され得る。
5. Refresh実行後は必ずaction snapshotをread-backする。

2026-09-25の実測では、新しいWorkspace Plugin管理UIからRefresh導線は見えなかったが、ChatGPT frontend内のaction Refresh実装は残っており、既存 `local-dev` のsnapshotを8 MiB表記から6 MiB表記へin-place更新できた。

## やらないこと

- **Plugin packageのVersion bumpをactions Refreshの代わりにしない。**
  - 2026-09-25に `1.0.0 -> 1.0.1` を実測したが、package versionだけが更新され、MCP action snapshotは旧8 MiB表記のままだった。
- page reloadだけでschema反映済みとしない。
- Workspace actions Refreshだけで既存chatも更新済みとしない。
- tool変更だけを理由にWorkspace Appを再作成しない。
- Workspace版とUSER版のpermission/approvalが合算されると仮定しない。
- Tunnel token、session cookie、connector credential、認証headerをlogへ出さない。
- undocumented endpointやlink IDを恒久的な契約として実装しない。

## fallback

既存Appの再作成・再公開は次の場合だけ行う。

- connector link/App自体が失われている
- auth modelまたはApp identityを変更する必要がある
- 現行clientにもRefresh flowが存在しない
- Refreshが失敗する
- Refresh後のsnapshot read-backが旧schemaのまま

再作成する場合も、replacementのactions・権限・実tool callを確認するまで既存Appを削除しない。

## 完了条件

次の4つがすべて新しいことを確認する。

- repository source
- running runtime schema
- Workspace Plugin action snapshot
- Branch/new chatのmodel-facing tool binding

`runtime=new / snapshot=old` ならRefresh不足、`runtime=new / snapshot=new / branch=old` ならBranch/rebind不足として扱う。

## ImageContent compatibility

`image.read` は現在、意図的に `outputSchema` を宣言しない。2026-09-25の実測で、ChatGPTのconnector bridgeは `outputSchema` がある `image.read` をstructured objectへ正規化し、MCP `content[]` のImageContentをmodel-facing resultから落とした。一方、`outputSchema` を持たない `mobile.screenshot` は同じImageContentを `content_items` として保持した。

画像を返すtoolで `outputSchema` を追加・復活させる場合は、ChatGPT上の実callで画像blockがmodel-facing resultに残ることを必ず検証する。unit testでMCP `content` にimageがあるだけでは十分ではない。
