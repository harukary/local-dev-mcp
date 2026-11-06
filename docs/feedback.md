# local-dev MCP feedback workflow

local-dev のツール利用統計（`tool.usage`）では、成功していても使いにくい操作、ツール不足、繰り返される非効率までは観測できない。認証済みMCPクライアントが発見した再現性のある課題を記録し、週次レビューで改善する。

## 登録

- `feedback.report`: `kind=bug|improvement|missing_feature`、`title`、`description`を指定する。必要なら`related_tool`、`impact`、`suggestion`、`project_id`を指定する。
- ChatGPTは選択中のprojectを補完する。Claudeは`context_id`を任意で渡すと、そのwork contextのprojectを補完する。Museはprojectを付ける場合に`project_id`を渡す。いずれも選択・指定なしでサーバー全体の課題として報告できる。
- 繰り返し再現する不具合、誤解を招く説明、不足機能、繰り返し必要な迂回操作などを簡潔に記載する。単発のネットワークエラーや通常のリトライは報告しない。
- 同じproject・kind・related_tool・正規化したtitleは自動的に1件へまとめ、`occurrences`を増やす。既知の項目に`existing_id`を指定すると、タイトル表現が違っても同じ課題として数える。解決済みの項目が再報告された場合は再オープンして`reopened`を増やす。
- 自動で取り込むのは実際のMCPクライアント種別、報告時刻、project選択状態のみ。ツールの引数、返却本文、会話全文やshell/browserの生ログは収集しない。報告本文にも秘密情報、実ユーザーデータ、認証済みページのHTML等を含めない。保存時には一般的なcredential文字列を追加マスクするが、完全な秘匿化を保証する仕組みではない。

## 一覧と対応

- `feedback.list({})`: 未解決（`open`と`in_progress`）を最新更新順で取得。project未指定なら全project、既定50件・最大100件。必要なら`offset`でページングする。
- `feedback.list({status:"all", recent_days:7})`: 直近7日間に登録・再発・更新した全報告（解決済みを含む）。
- `feedback.update({id,status:"in_progress",note:"..."})`: 原因調査や修正中であることを示す。
- `feedback.update({id,status:"resolved",resolution:"検証結果や関連コミット"})`: 修正と検証が終わってからクローズする。解決・dismissにする際は初回の理由記載が必要。`dismissed`は対応不要と判断した根拠を残すために使う。
- `resolution`は以前の修正内容の参照にもなるため、後日再発しても保持する。`latest_note`は最新の経過記録であり、完全な監査履歴ではない。

## 週次レビュー

毎週、`tool.usage({recent_days:7})`とともに次を実行する。

1. `feedback.list({status:"active"})`で未解決課題を確認（必要なら全件ページング）。
2. `feedback.list({status:"all",recent_days:7})`で新規・再発・最近の解決を確認。
3. エラー頻度、発生回数、再発回数、ユーザー影響、実装工数を見て優先順位を判断する。単なる件数増を品質改善とはみなさない。
4. 原因と対策を示し、実装・検証できたものは`feedback.update`で結果を記録する。分析・提案のみを指示されたScheduled Taskではコード変更・状態更新は行わない。
5. 新しい報告がなくてもその旨を明記し、前週改善した項目の再発有無を確認する。

## 保存と運用

- 正本はMCP実行ホストの`~/.local-dev-mcp/runtime/feedback.json`。既存の`logs/tool-usage.json`とは別で、Git管理対象ではない。
- ディレクトリの権限は0700、データファイルは0600。更新は単一サーバーのキューで直列化し、一時ファイルからrenameして保存する。無効・破損したデータは黙って初期化せず、起動時にエラーとする。
- 同じHTTPサーバーのChatGPT・Claude・Museは同じ正本を見る。別ホストの`local-dev-mini`は別のローカル正本を持つ。ホスト間の自動同期はしない。
- 5000件を上限とし、一覧レスポンスは最大100件。報告を大量自動生成する設計にはしない。
