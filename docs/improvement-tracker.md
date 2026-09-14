# 汎用性能・出力効率の改善台帳

対象: 2026-09-08に監査した40候補。既存mainの未コミット変更を維持して実装。
優先順位: 正確な対象操作とタスク完遂、失敗からの復帰、出力効率。
ソースのスキーマ版: `2026-09-14.2`。

**全40候補の実装完了・本番反映完了ではない。**
「ローカル検証済み」は記載したテストの範囲だけを指す。
稼働中MCPへの反映・Tunnel connector経由の呼出しは確認済み。ChatGPT Web画面、Android画面は別の受け入れゲート。

## 対応状況

| ID | 改善対象 | 今回の対応・証拠・残る範囲 |
| --- | --- | --- |
| 1 | Shellのcwdキャッシュ | cwd/defaultShellをキャッシュキーへ追加。実際のpwdで切替を検証済み。 |
| 2 | Patchの全件preflight | 全変更をメモリで計画し競合を先に検出。ファイル単位の一時ファイル置換、部分反映一覧。競合・dry run検証済み。複数ファイル全体のトランザクションではない。 |
| 3 | CDP期限・キャンセル | 接続/コマンド15秒、切断時pending解放、MCPキャンセル伝播。疑似WebSocket検証済み。 |
| 4 | 永続job回復 | 全job開始時に記録。再起動後のrunningをinterrupted/unknownへ分類。PIDだけで所有権・終了コードを推測しない。旧jobの終了コード復元は不可能。2026-09-14確認ではlong-running childは独立process groupでもstdout/stderr pipeをMCP親processが保持しており、server restartを無停止job migrationとは扱えない。 |
| 5 | 操作と観測の分離 | 操作後のwait/snapshot/image失敗にaction_applied/retry_actionを返す。一次観測エラーを保持するテストあり。 |
| 6 | Path policy | 実体path・存在する祖先・元project policyRootを検査。denied先/外部へのsymlinkを拒否。dangling linkとsymlink patchも拒否。OSレベルの競合完全排除ではない。 |
| 7 | Notes validateの副作用 | 2026-09-14.2で`notes.*` / `private_notes.*`を汎用MCP surfaceから削除。private-notes固有処理は同repo既存の`pnpm run new/build/check`へ戻し、homepage notesは通常のworkspace編集 + Astro buildを使う。 |
| 8 | Patch失敗分類 | syntax/conflict/unsupported/path/write段階を分離。changed_filesとpartialを返す。2026-09-14にinputSchemaもreplacement / exact text edit / complete unified diffの`oneOf`へ厳格化し、混在mode・不足field・bare hunk相当を実行前validationで拒否する。 |
| 9 | Exact text edit | 既存old_text/new_text実装を統合。曖昧一致の拒否・replace_all・文字列中のドル記号を検証済み。 |
| 10 | 呼出単位diff | jsdiffでbefore/afterから生成。未追跡ファイル・Git外・連続編集を検証済み。 |
| 11 | 検索ストリーム | rg出力を逐次処理。件数・8MiB・30秒上限、offset継続。終了/例外/キャンセル時に子プロセスを回収。 |
| 12 | 検索context重複 | 同じファイルをPromise cacheで一度だけ読む。ファイル4MiB、全体16MiB上限。 |
| 13 | 長い行・継続位置 | UTF-8 byte予算、start_column/next_start_line/next_start_column。日本語境界の読み飛ばし回帰テストあり。大ファイルの単一行はreadlineの行バッファを使用。 |
| 14 | Glob | Node標準matchesGlobへ変更。rootとnestedの**/*.tsを検証済み。 |
| 15 | Read-only batch | workspace.batch: read/search/listのみ、最大20件、4並行。選択project/cwdを固定。実MCP dispatcher経由のテストあり。2026-09-14にserver instructionsとread/searchのtool descriptionから、独立2件以上ではbatchを優先する契約を明示。 |
| 16 | Git境界 | status/worktreeともporcelain -z、空repo、bounded show/diff。tab/newlineを含むファイル名・worktree pathと空repoを検証済み。 |
| 17 | 非Node project | Python/Rust/Go/Swift/JVM等のmanifest検出。unknown testのような架空コマンドを返さない。Rust検出テストあり。 |
| 18 | Skills cwd/reference | 選択cwdのnested Skillと配下のtext referenceを読めるよう統一。許可root外を拒否。テストあり。2026-09-14に`skills.list`へquery/scope/detailを追加し、既定summaryはreadに必要なpathを残しつつrelative_path/enabledを省略。 |
| 19 | Skills YAML/cache | js-yamlによるfront matter解析、mtime/size cache。複数行descriptionを検証済み。filter後countと全体total_countを分離して返す。 |
| 20 | Browser入力品質 | Playwright locatorでclick/fill/press。actionabilityとキー修飾を既存エンジンに委譲。隔離Chromeで実入力・クリック検証済み。 |
| 21 | Browser操作範囲 | iframe/Shadow DOM/role locator、hover/select/check/uncheck/drag/uploadを追加。iframe/Shadow DOM/roleは実Chrome検証済み。dialog/download専用契約は未実装。 |
| 22 | CDP再利用 | CDPとPlaywright接続pool、idle解放、drain時close。接続解除後もChromeが生存することを検証済み。 |
| 23 | 条件wait | Playwright wait、共有timeout、条件なしwait拒否。open/reloadはdomcontentloadedを待機。history遷移の観測は別ゲート。 |
| 24 | Device探索再利用 | 10秒cache、exact ID再利用、失敗時無効化。探索回数の実端末ベンチマークは未実施。 |
| 25 | Device競合/参照世代 | 曖昧device選択拒否、会話のdevice記憶、device単位queue、snapshot IDと古いref拒否。実端末での複数会話競合は未検証。 |
| 26 | 外部操作期限 | CDP HTTP、Todo、mobile CLI、Gitに期限。主要経路にMCPキャンセル伝播。device discoveryはbackend単位の成功/失敗を返し、部分成功を利用する。 |
| 27 | Todoサーバー絞込 | **外部契約待ち**。todo-serviceの現行APIはactive一覧がbootstrapのみ。local-dev-mcp側で未実装APIを推測呼出ししない。 |
| 28 | Todo部分反映 | 全children事前検証、失敗時created_ids/next_child_index/unknown outcome、全体再試行・rollback削除をしない。障害注入テストあり。server側idempotencyは外部契約待ち。 |
| 29 | Compact JSON | workspace/Git/notes/browser/mobile/status/schemaの主要JSONをcompact化。structuredContentとtextの両方はクライアント互換性のため維持。token削減率は未測定。 |
| 30 | DOM出力予算 | text/html/both、既定text、32KiB既定/128KiB上限。切詰めを明示。 |
| 31 | 観測モード | browser/mobileにnone/after/snapshot。browser.screenshotはclip/scale対応。100x80領域をscale=2で200x160 PNGとして得ることを実Chromeで検証。mobile専用cropは未実装。 |
| 32 | Shell診断保持 | 非同期jobは各stream先頭8MiB＋bounded末尾を保持。9MiB出力後の最終診断を検証済み。無制限raw logはsecret/容量リスクから追加しない。同期Shellの既存上限は維持。 |
| 33 | Shell polling | 16KiB既定byte予算、cursor、has_more、none/tail。繰返しcommand/purposeを除去。日本語cursorを検証済み。poll待機は100msの内部確認を維持。 |
| 34 | Shell stdin | 非対話stdinをignoreへ変更。**PTY/対話入力は承認契約待ち**: 初期command承認後のstdinで任意commandを投入できる迂回を作らない。 |
| 35 | Tool discovery | tool.schemaにprefixとsummary/full。summaryのbyte削減をテスト。tools/listの機能を隠すlazy化はChatGPT互換性確認なしには採用しない。 |
| 36 | 共通契約 | 全schemaをAjvで実行前検証。AsyncLocalStorageでrequest cancellationを分離。副作用のexactly-once保証は外部サービス協調なしに追加しない。 |
| 37 | Context永続化 | 保存直列化、一時ファイルrename、0600。同時saveの順序を検証済み。永続project/cwdを無断で期限切れにするTTLは追加しない。 |
| 38 | 公平性・上限 | 2026-09-14.2で会話別rate map / 100req/min / 8同時制御を削除し、runaway防止の全体64 in-flight capだけ維持。loopback + Secure MCP Tunnel tokenが主要境界。 |
| 39 | Metrics | response bytes、latency histogram、error code、run ID、任意build ID、終了時flush。旧集計と新measurementの分母を分離して検証済み。2026-09-14にrequest bytes / structured response bytes / text response bytesを追加し、`tool.usage`は既定top-30 summary + project/prefix/limit filter、必要時のみdetail=fullへ変更。さらに最大31日分のUTC日次bucketをtool/project別に保持し、`recent_days`でrecent bytes/failures/latencyを直接集計可能にした。 |
| 40 | Behavior/client評価 | mockだけでなく実ChromeとMCP dispatcherのテストを追加。下記の最終検証記録を正本とする。ChatGPT Web/Androidは未確認。 |

## ツールの変更点

- `workspace.read`: 出力上限到達時はnext_start_line/next_start_columnから継続する。max_bytesはUTF-8本文の予算で、JSON envelopeは含めない。2026-09-14から既定予算は512KiBではなく64KiB。
- `workspace.search`: next_offsetから継続する。出力/時間上限時はpath/globを絞る。previewとcontextは個別に切り詰められる。2026-09-14から既定件数は100ではなく50。
- `workspace.batch`: 各項目の成功/失敗を独立して返す。副作用のあるtoolや再帰batchは受け付けない。2026-09-14から既定compact resultでrequest側と重複するproject/query/absolute path等を省き、必要時だけdetail=full。
- `shell.status`: output=noneで状態のみ、tailで保持済み末尾、既定はcursor付きのbounded出力。stdout_truncated/stderr_truncatedは保持上限による欠落を示す。
- `browser.click/type/press/interact`: CSSに加えてPlaywrightのtext/role locator、任意iframe。複数一致は暗黙に最初を操作しない。
- `mobile.tap_element`: refは同じ会話の直近snapshotに限る。device操作や他会話のsnapshotで無効化する。画面自体の非同期変更まで完全検出する保証ではない。
- `tool.schema(prefix,detail)`で対象だけ取得できる。tool追加・input schema変更時は、MCP runtime反映 → ChatGPT Plugin Refresh → Branch chat（または新規chat）でconversation側のtool bindingを再解決する。公式に十分書かれていない観測仕様と切り分け手順は`docs/chatgpt-user-plugin-schema-refresh.md`を参照。
- `skills.list(query,scope,detail)`は既定summary。特定Skillを探す追跡呼出しではquery/scopeで絞り、追加metadataが必要な場合だけdetail=fullを使う。
- `tool.usage(detail,project_id,prefix,limit,recent_days)`は既定lifetime summary。`recent_days=1..31`でUTC日次bucketを集約し、project/tool単位のrecent calls・failures・duration・request/response bytesを返せる。引数や出力本文は記録しない。wire bytesとmodel tokenは同一ではない。

## 2026-09-14 利用ログ追補

- 2026-09-08以降のmeasurementでは`workspace.read`、`shell.status`、`shell.run`、`workspace.search`、`skills.read`が主なresponse byte消費源。`workspace.batch`利用は独立read/search/list総数に対して極端に少なかったため、model-visible instructionを追加した。
- `workspace.patch`はrecent measurementで約43%がfailure。大半がPATCH_PATHS_NOT_FOUND / PATCH_SYNTAXで、content conflictではなく入力契約の問題だったため、runtime内fallbackではなくJSON Schemaの`oneOf`で実行前に拒否する。
- `jsonResult`はstructuredContentと同一JSON textを現在も併記している。MCP SDK 1.29.0ではstructuredContent単独相当もschema上は受理できることを確認したが、ChatGPT Android/Webを含む実client互換を推測で変更しない。先にstructured/text別byte計測を追加し、実測後に判断する。
- `tool.usage`自体が大きなaggregateを返していたため既定をtop-30 summaryへ変更。full snapshotは明示`detail=full`時のみ。今後の「最近の利用」分析用に、tool/project別のUTC日次bucketを31日だけ保持し`recent_days`で直接絞れるようにした。
- `skills.list`は既定summary、`workspace.read`既定64KiB、`workspace.search`既定50件へ縮小。`workspace.batch`の代表4操作ではcompact化単体でstructured resultを27,405Bから26,800Bへ約2.2%削減し、主効果はmetadata削減よりcall consolidation側と判断。
- 利用ログ改善の初期実装はsource schema `2026-09-14.1` で検証し、その後のcleanupで `2026-09-14.2` へ更新した。初期実装時は`pnpm typecheck && pnpm test` 50 files / 235 tests pass、`pnpm build`と`git diff --check`も成功。
- 2026-09-14.2 cleanup: `notes.*` / `private_notes.*` 7 tools、未参照`external-browser.ts`、未使用`/ui`・`/debug/tools`・root POST/GET・HTTP `/reload`、CORS direct dependency、会話別rate limiterを削除。`workspace.patch`のqueue keyを`policyRoot ?? hostRoot`へ修正。Bitwarden mappingを`~/.local-dev-mcp/.bitwarden.env`へ移行し、`HARUCLAW_HOME`コード依存を削除。
- cleanup後のbuilt schemaは75 tools / 45,774 bytes、`notes.*` / `private_notes.*`なし。full verificationは47 files / 224 tests pass、typecheck/build/diff-check成功。
- 2026-09-14にcommit `6bfa118` を`origin/main`へpush後、live MCPを再起動してschema `2026-09-14.2` / 75 toolsを確認した。再起動時は既存long-running processの生存もread-backした。ChatGPT側ではPlugin Refresh後にBranch chatすると新しいtool bindingへ切り替わる運用知見を確認した。

## 検証・反映の境界

- テストのjob storeをgenerated配下の一時領域へ隔離した。以前のtest helperが実repoのjob storeを削除し得る経路を修正した。
- Browser実操作テストはheadless Chromeの隔離profile。利用者のgolden/browser sessionは操作していない。
- MCP統合テストはSDK InMemoryTransportと本番dispatcher。Secure MCP TunnelやChatGPT UIの代替証跡ではない。
- 反映前のconnectorはschema `2026-09-08.2` / 79 toolsだった。ユーザー承認後の再起動により `2026-09-08.3` / 82 toolsへ反映した。
- 再起動直前の生存jobはhundred-year-diaryのMetro 1件。MCPと別process groupだったが、再起動後に消失した。元command/cwdで復旧し、8085のHTTP応答を確認した。別process groupだけでrestart耐性を保証してはいけない。
- Tunnel設定変更・commit・pushは未実施。未コミットの作業ツリーを既存launchd起動経路へ反映した。
- artifact.read / artifact.receiveの転送実装は変更していない。既存ユーザー差分と今回の実装を区別する。

## 残る判断・外部ゲート

1. サーバー反映と既存connector経由の新版動作確認は完了。ChatGPT側の新規tool一覧へのRefresh、Web/Androidの画面操作確認は未実施。
2. Todoのserver側paging/filter/idempotencyは別repo `todo-service` のAPI契約・実装・反映を伴う。このrepoだけでは完結しない。
3. PTY/任意stdinを公開する場合は、会話所有権・承認・credential scope・入力監査・secret抑制を含む新しい契約が必要。
4. dialogの自動応答・downloadの保存/許可方針は、共有CDP contextの既定動作を変え得るため未実装。mobile専用cropも未実装。全40候補が完了した扱いにはしない。
5. 実トークン・latency改善率は、反映後の同じタスク群/モデル/クライアント条件で比較する。wire bytesはモデルtokenではない。

## 最終検証

- pnpm exec vitest run: 50 files / 234 tests passed、skipなし。
- build成功、git diff --check成功。既存dirty差分を含む作業ツリー上で実行。
- build artifactのread-back: schema 2026-09-08.3、82 tools。
- full schema snapshotは47,035 bytes、workspace summaryは5 tools/1,300 bytes。
- ツール追加によりfull schemaは監査時の約42.5KBより増加した。起動時トークン削減を達成したとは報告しない。summaryは対象を絞った追加取得の効率化である。

## 稼働環境への反映記録

- 2026-09-08、ユーザーの再起動承認後にtypecheck/buildを再実行し成功。
- 既存MCP子processへSIGTERM。launchdが既存server.sh経由で再起動。Tunnel process/configは変更していない。
- 新instance: `a501d9a9-06f2-40fd-a7e2-75aafcb8512e`、起動時刻 `2026-09-08T02:22:47.636Z`。
- loopback healthz 200、認証付きdebug/toolsは新版82 tools、認証なしdebug/toolsは401。
- 接続中のlocal-dev connectorからtool.schema(prefix=workspace.,detail=summary)成功。workspace.readは12-byte制限/継続column=12を返し、workspace.patchのno-op dry-runも成功。
- SDK HTTP clientから本番MCP dispatcherへworkspace.batchを送信し、read 12 bytes/list 3 entriesを確認。shell.status(output=none)はstdout/stderrを返さずrunningを確認。
- 最新server startupのログ抽出ではlisteningあり、Fatal error/port競合/異常終了の記録なし。
- 再起動中に旧Metro job `291209de-d069-4aed-8c6d-bb611c8ed291` と8085 listenerが消失。正確な終了シグナル・一次原因は未取得で、無停止維持に成功したとは扱わない。
- 元cwd `/Users/inoueryo/workspace/hundred-year-diary` のmainを確認し、元command `pnpm start:dev-client` で復旧。新job `5e58b8d8-186b-4d45-af6f-d54580b14e77`、PID 38284、long_running=true。8085 `/status` は200 / `packager-status:running`、`/` も200。
- この復旧jobは意図的に稼働継続。hundred-year-diaryのsource変更・build・アプリ画面検証は行っていない。
- 新規toolのChatGPT UI discovery/Plugin Refresh、Web/Androidでの実画面操作は未確認。connectorの成功をAndroid実機検証と呼ばない。
