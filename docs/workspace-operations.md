# Workspace batch と patch

## Batch の利用統計

`workspace.batch` は複数の読み取り・検索・一覧取得を実行し、`results[]` に各項目の結果またはエラーを返す。部分失敗しても、成功した項目の結果は維持する。

`tool.usage` では、外側の呼び出し数 `calls` と内部の結果を区別する。

- `batch_items_total`: Batch 内で処理した項目の総数
- `batch_items_failed`: 内部結果に `error` があった項目数。出力予算超過 (`BATCH_OUTPUT_LIMIT`) も含む
- `partial_failures`: 成功項目と失敗項目が混在した Batch 呼び出し回数
- `batch_item_error_codes`: 内部エラーコードごとの件数。パス・本文・リクエスト引数は記録せず、異常なコード値は `UNKNOWN_BATCH_ITEM_ERROR` にまとめる
- `failures`: 外側の失敗呼び出し数。Batch の全項目が失敗した場合は `BATCH_ALL_ITEMS_FAILED` として計測するが、既存の `workspace.batch` の結果形式は変えない

内部項目の件数とエラーコードの内訳は、それぞれ導入後の呼び出しから記録し、過去の集計値は補完しない。プロジェクト別・直近期間の比較には `tool.usage({ project_id: "...", prefix: "workspace.batch", recent_days: 7 })` を使用する。

## Patch の競合防止と再実行

`workspace.patch` の `old_text` は、対象ファイル内で一意に一致する正確なテキストを指定する。複数箇所に同じ文字列がある場合は長い固有の文脈を含め、全箇所の変更が必要な場合のみ `replace_all` を使う。

`expected_sha256` は呼び出し開始時の**元ファイル**のSHA-256と比較する。同じ呼び出しで同じファイルに連続する複数の編集を行う場合も、同じ元SHAを指定できる。

unified diffでは差分の文脈一致を維持しながら改行コード差異を許容する。文脈が変更されていた場合に内容を推測して適用することはない。

`PATCH_CONFLICT` では可能な限り `actual_sha256` と `recovery` を返す。`re_read_target` の場合は `workspace.read` で現在の内容を確認してから新しいpatchを作る。`use_unique_context` の場合は `old_text` を長くして一意にする。既存の競合保護や書き込み直前の再確認は無効化しない。
