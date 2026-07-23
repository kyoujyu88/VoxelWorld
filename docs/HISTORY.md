# HISTORY — 変更履歴と判断の理由

> 新しいものを上に追記する。各エントリに「何を」「なぜ」を残す。

---

## 2026-07-23 — Phase 4 実機合格（R8）+ フェーズ表示の更新

### 実機結果（R8 合格）

`?v=7` / `build: 2026-07-23 05:25Z`（Phase 4 ビルド）を Pixel 9a で確認。屋外スキャンで **`描画 150,000 / 150,000`（描画上限）・`ボクセル 600,000`（グリッド上限）でも `FPS 74`** を実測。完了条件「10 万で 30fps」を大きく上回り **R8 合格 → Phase 4 完了**。カメラ実色も屋外の草・土で実物どおり。

### 何を

- `src/main.ts`: 画面に残っていた「Phase 3」表示を実態に合わせて更新。ランディングの説明文と AR 内 HUD タイトルを **Phase 4（描画最適化 / 最適化描画）** に変更（ユーザ指摘: 「はじめの画面のフェーズが 3 のまま」）。表示文言のみでロジックは不変。
- docs: `PROGRESS.md` の Phase 4 と R8 を ✅ 化し、実機合格記録と「要判断（上限到達）」を追記。

### なぜ / 判断

- **フェーズ表示は進捗インジケータとして使われている**ため、完了済みフェーズを指したままだと誤解を招く。実態（Phase 4 完了）に合わせた。コード内コメントの「Phase N」は各機能の導入経緯を示す正しい記述なので据え置き。
- **描画/グリッド上限への到達（屋外で `破棄` 発生）は Phase 4 の範囲外**として据え置き: FPS には余裕（74）があり上限引き上げは可能だがメモリ増を伴う。表示数の根本的な削減は Phase 6（ボクセルサイズ可変＝整数倍ダウンサンプル）で扱うのが設計上自然なため、まず Phase 5→6 を進める。屋内（本命）は上限内に収まる想定。

### 検証

- ローカル: `tsc --noEmit` green、Vitest **36** green、`vite build` 成功（`__BUILD_ID__` 置換確認）。表示文言変更のみ。

---

## 2026-07-23 — Phase 4: 描画最適化（差分追記 + FPS メータ）（+ Phase 3 実機合格）

### Phase 3b 実機合格（R7 確定）

カメラ実色 readback が実機で動作。ボクセルが**実物の色**で着色され、サムネイルにカメラ縮小画像が表示（readback 成功）。色の向きは **X:正 / Y:反転**（`camFlipX=false` / `camFlipY=true`）で実物と整合することをユーザがスクショで確認 → **R7 合格**。これで Phase 3（深度→ワールド→2cm ボクセル→実色）は幾何(R6)・色(R7)ともに実機確認済みで**完了**。

### 何を（Phase 4）

- `src/voxel/grid.ts`: 変更セル追跡を追加。`addPoint` が触れたキーを `dirty: Set<number>` に記録。`drainDirty(cb)` で「前回以降に変化したキーだけ」を走査してクリア（無割り当て）。`readVoxel(key, out)` で 1 セルのワールド中心+平均色+観測数を `out` に詰めて返す（`forEach` の全走査を使わず 1 セルだけ読む経路）。`clear()` は dirty も消す。
- `src/render/voxelRenderer.ts`: 毎フレーム全再構築を廃止し、**追記専用**に書き換え。`applyUpdates(grid, minObs)` が dirty セルだけを見て、新たに閾値到達した未描画セルを InstancedMesh 末尾に追記。`keyToInstance` で二重追加を防止。追記した連続範囲のみ `instanceMatrix.addUpdateRange(start*16, added*16)` / `instanceColor.addUpdateRange(start*3, added*3)` で部分アップロードし、`mesh.count` を伸ばす。`reset()` でクリア（クリアボタン用）。
- `src/main.ts`: ループを差分駆動に。毎フレーム `voxels.applyUpdates(grid, MIN_OBS)`（O(変化数)）。`REBUILD_MS`(全再構築間引き) を廃し、`STATS_MS`(250ms) の統計間引きへ。`frameCount` を数え `fps = frameCount*1000/経過` を算出、HUD 一行目に `FPS` を表示。「クリア」は `grid.clear()` + `voxels.reset()`。
- `test/grid.test.ts`: dirty 追跡と `readVoxel` に 4 件追加（drainDirty は各セル 1 回→クリア / readVoxel の中心・平均色・観測数 / 不在キー→false / clear で dirty 空）。計 **36** 件。

### 主要な判断とその理由

1. **全再構築 → dirty 差分の追記専用に**
   - 理由: 旧実装は `forEach` で毎回グリッド全セルを走査し InstancedMesh を作り直していた（O(グリッド全体)/更新）。10 万規模では毎回 10 万走査で 30fps を割る。ボクセルは基本「増える一方」なので、変化セルだけ追記すれば更新コストは O(変化数) に落ちる。GPU 転送も追記分の連続範囲だけに絞れる（`addUpdateRange`）。
2. **既存インスタンスは「最初に閾値到達した時の色」で固定**
   - 理由: 追記専用にすると既存ボクセルの色は更新されない。だが色の**真の移動平均は grid 側が保持**し続けるので、エクスポート（Phase 7）は正しい平均色を出せる。表示は速度優先で固定色にし、正確さは内部表現に委ねる（表示と内部の分離という設計方針に一致）。
3. **色の再描画はしない（差分は追記のみ）**
   - 理由: 「色を後から更新」まで差分に含めると dirty セルごとに `setColorAt` の再アップロードが要り、動く物体で発火し続ける。MVP の完了条件は「30fps 維持」なので、まず追記のみで実現。色更新の増分は必要になった段階で検討。

### 検証

- ローカル: `tsc --noEmit` green、Vitest **36** green、`vite build` 成功（`__BUILD_ID__` 置換確認）。
- 未確認（実機）: R8（10 万ボクセルで FPS≥30 維持）。→ `docs/PROGRESS.md` の Phase 4 手順で依頼。

---

## 2026-07-23 — Phase 3b: カメラ実色 + ビルド表示（+ Phase 3.1 実機確認）

### Phase 3.1 実機確認（?v=2 で新版）

ノイズ低減が効いた: `89,036 セル`（前 400k）/ 描画 `48,745`（前 150k）/「破棄」消滅。**椅子・ドア・床がボクセル形状で認識でき整列**、flipY=ON 確定、二重壁は体感なし → **R6 幾何は実機で確認**。ユーザ所感「少し見やすくなった」。横縞は stride2 の密度ムラ（軽微）。残課題は「色が分かりづらい」＝実色化。

（途中、古いキャッシュの旧版を見てしまう事象。原因は GitHub Pages が index.html を ~10 分キャッシュするため。`?v=` で回避できることを確認 → 恒久策として下記ビルド表示を追加。）

### 何を（Phase 3b）

- `src/xr/cameraColor.ts`: `CameraColorReader`。`XRWebGLBinding.getCameraImage(view.camera)` の WebGLTexture を FBO に attach → `blitFramebuffer` で 96x214 に縮小 → `readPixels` で CPU バッファ化（WebGL2）。`sample(u,v)` で正規化ビュー座標から色を引く。全操作を try/catch で保護し、失敗時は `failed` を立てて高さ色にフォールバック（AR 表示は絶対に壊さない）。`flipX/flipY` で色の向きを実機調整。
- `src/xr/reproject.ts`: `PointSink` を `(x,y,z,u,v)` に拡張（u,v = 正規化ビュー座標 = カメラ画像 UV）。
- `src/main.ts`: 毎フレーム描画後にカメラ readback（~10Hz スロットル）→ `renderer.resetState()` で three の状態を再同期。ボクセルはカメラ色（失敗/未取得時は高さ色）。操作に「🎨 色: カメラ/高さ」「🔃 色向き(4通り循環)」を追加、`↕上下反転` は flipY=ON 確定のため撤去。HUD にカメラ縮小サムネイル（readback 診断）+ 色状態。
- `vite.config.ts` + UI: `__BUILD_ID__`（ビルド時刻）を define し、トップページと HUD に `build:` 表示。キャッシュで古い版を見た時に一目で分かる。

### 主要な判断とその理由

1. **色は CPU readback（FBO+blit+readPixels）で取得**
   - 理由: 色はボクセルごとに移動平均で蓄積・エクスポートするため CPU 値が要る。`getCameraImage` は GPU テクスチャのみなので downscale して readback。full 855x1920 は重いので 96x214 に blit してから読む（GPU stall 低減、~10Hz）。
2. **徹底したフォールバックと診断**
   - 理由: readback はブラウザ/端末依存で最も壊れやすい。失敗しても高さ色で動作継続し、AR 表示を壊さない。サムネイル+色状態+色向きトグルで、実機だけで原因切り分け・向き調整ができるようにした（Web 検索はレート制限中のため、確定 API=getCameraImage + 標準 WebGL2 の範囲で実装し、不確実な向きは実機調整に委ねる）。
3. **ビルド表示の追加**
   - 理由: 実機テストで旧キャッシュ版を見てしまう事故が起きたため。`build:` 時刻で今の版が一目で分かる。恒久的な自動更新(SW)は複雑さ回避で見送り、`?v=` + 表示で対処。
4. **`↕上下反転(reproject flipY)` トグルを撤去**
   - 理由: R6 で flipY=ON が正しいと実機確認できたため、`flipY: true` に固定してボタン枠を色操作へ。

### 検証

- ローカル: `tsc` green、Vitest **32** green、`vite build`（`__BUILD_ID__` 置換を確認）。
- 未確認（実機）: R7 色（実物色になるか・色の向き・サムネイル・readback 可否）。→ `docs/PROGRESS.md` の Phase 3b 手順で依頼。

---

## 2026-07-22 — Phase 3.1: ノイズ低減と見やすさ改善

### Phase 3a 実機フィードバック（スクショ）

- **良い兆候**: ボクセルが面に概ね整列。床が密・天井が疎で、高さ順が正しく、`flipY=ON` が正しい向き（床=下、天井=上）。距離中央 2.13m と妥当。→ 逆投影は実機で概ね正しく動作（R6 の大枠 OK）。
- **問題**: `ボクセル 400,000（グリッド上限）/ 84,772 破棄`、`描画 150,000`。不透明キューブが画面全体を覆い、①透けて面が見えない ②上下反転の効果が判別不能。色帯（高さ）が緑〜黄に潰れて構造が読みにくい。

### 何を

- `MAX_M` 4.0→**3.0m**（遠方は最ノイズ。範囲を絞りドリフト/偽ボクセルを抑制）。
- `MIN_OBS` 2→**3**（複数回観測した安定セルのみ描画＝一過性ノイズ除去）。
- `GRID_CAP` 400k→**600k**（正当なスキャンでの破棄を減らす）。
- ボクセル立方体を `0.9`→**`0.55`** サイズ（隙間からカメラ映像が透け、面に乗っているか判別可能に）。
- 高さ色の窓を実室内レンジ（-1.3〜1.7m）に合わせ彩度を上げ、**低=青/中=緑/高=赤**の明確な帯に。

### なぜ

- ユーザ報告「色分けが少なすぎる」「画面が塗りつぶされ反転効果が不明」に直接対応。まず**見やすく＝ R6 を目視確認可能に**するのが先決。実色(camera-access)は次の増分（3b）で本対応。低リスクな調整を先に切り、camera-access の readback 実装は独立した増分にして切り分ける。

### 検証

- ローカル: `tsc` green、Vitest 32 green、`vite build`。パラメータ/色/サイズ変更のみでロジック(grid/reproject)は不変。
- 未確認（実機）: 改善後の見やすさ・整列・二重壁の程度（R6 最終目視）。

---

## 2026-07-22 — Phase 3a: ボクセル蓄積（+ Phase 2 実機合格）

### Phase 2 実機合格

ヒートマップが動作、深度有効率 100%、距離 1.43–4.59m と妥当（R5 合格）。ユーザ指摘: 下の深度表示の向きがカメラと合わない → 生の深度バッファ（横長）をそのまま描いているため。データは正しく表示のみ。整列は Phase 3 の逆投影行列で対応する方針で合意。

### 何を（Phase 3a）

- `src/xr/reproject.ts`: 深度テクセル→ワールド点の逆投影。`normDepthBufferFromNormView^-1` → 正規化ビュー → NDC → `projectionMatrix^-1` でレイ → 垂直深度でスケール → `view.transform` でワールド化（three の Matrix4/Vector4、スクラッチ再利用）。`flipY` を切替可能に。
- `src/voxel/grid.ts`: スパース 2cm グリッド。整数セルを 17bit×3 で 1 個の安全整数キーにパック、`count` と色 sum を蓄積、`maxVoxels` 上限、`minObservations` フィルタ（外れ値/一過性ノイズ除去）。
- `src/render/voxelRenderer.ts`: InstancedMesh（小立方体・インスタンス色）をグリッドから再構築（間引き）。
- `src/main.ts`: 毎フレーム逆投影→蓄積（色は暫定=高さ）、~4Hz で再描画。操作: 一時停止/クリア/**上下反転(flipY)**/終了。HUD にボクセル数・描画数・深度有効率・状態。
- Vitest +13（grid 9・reproject 4）で計 32。

### 主要な判断とその理由

1. **逆投影の数学は three.js の Matrix4/Vector4 で実装**（自前の逆行列は書かない）
   - 理由: 逆行列など誤りやすい部分を実績あるコードに委ねる。node でも動くのでユニットテスト可能。
2. **flipY を UI トグルに**
   - 理由: 「正規化ビュー座標の y 上下」は一次情報で確定できず実機依存（R6）。トグルにすれば再デプロイなしで実機で正解を確定できる。
3. **ボクセルは AR ビュー内に 3D 描画して検証**
   - 理由: Phase 3 完了条件は「形状が正しく蓄積」。実面にボクセルが積もる様子を AR で見れば、位置/向き/実寸（＝逆投影の正しさ, R6）を直接確認できる。基本描画は Phase 3 に前借りし、Phase 4 で最適化。
4. **色は暫定で高さ色、実色(camera-access)は 3b へ**
   - 理由: 幾何と R6 キャリブが最優先。色は承認済み方針(実色)で次段に追加。

### 検証（自分で catch したバグ）

- 逆投影のユニットテストで、右列テクセルが +x に来ず −2.88 になる失敗を検知。原因は `_invProj` に `.invert()` を付け忘れ（順投影のまま適用）。z が偶然 −2 になり気づきにくいバグだったが、テストが実機デプロイ前に捕捉。修正後 32 件 green。
- ローカル: `tsc` green、Vitest 32 green、`vite build` 成功。
- 未検証（実機）: R6（ボクセルが実面に正しい位置・向き・実寸で積もるか、flipY の正解）。→ `docs/PROGRESS.md` の手順で依頼。

---

## 2026-07-22 — Phase 2: 深度の可視化（+ Phase 1 実機合格）

### Phase 1 実機確認結果（Pixel 9a / GitHub Pages 経由）

全項目パス。RESEARCH.md の予測（160×90）とも一致:

- `depthUsage` = **cpu-optimized**（第一希望。GPU readback フォールバックは不要）
- `depthDataFormat` = **luminance-alpha**（uint16）
- `enabledFeatures` = viewer, camera-access, local-floor, local, dom-overlay, depth-sensing
- 深度バッファ = **160 x 90**、`rawValueToMeters` = **1.0e-3**（生値は mm。1mm 精度で 2cm ボクセルに十分）
- `camera-access` = **有効（カメラ画像 855 x 1920）** → 色取得の前提クリア（R7）
- → R1〜R4, R7 合格。R5 は Phase 2 で確認。

### 何を（Phase 2）

- `src/xr/depth.ts`: `readCpuDepthFrame()` — width/height/型付きデータ/rawValueToMeters/normDepthBufferFromNormView と `metersAt()`。フォーマット非依存（uint16 / float32）。Phase 3 の逆投影で再利用。
- `src/render/depthHeatmap.ts`: 純関数 `depthToRGBA`（近い=明るい、欠損=透明、範囲クランプ）と `computeDepthStats`（有効率・min/中央/max[m]）+ `DepthHeatmapView`（canvas + ImageData）。
- `src/main.ts`: AR オーバーレイを下部 HUD 化。深度ヒートマップ canvas（~15Hz）+ 凡例 + 統計（~4Hz）+ 終了ボタン。
- `src/style.css`: dom-overlay ルートは UA 制御のため透過パススルーにし、可視要素は子 `.hud` に集約（safe-area 対応、下部固定）。
- Vitest 8 件追加（計 19）。

### 主要な判断とその理由

1. **Phase 2 は 2D canvas ヒートマップで可視化**（AR 空間へのシェーダ整列はしない）
   - 理由: 完了条件は「動かすと深度が取れているのが目視できる」こと。2D ヒートマップが最短で明確。カメラ整列は Phase 3/5 の課題（深度160×90 は横長、カメラ855×1920 は縦長で向きが異なる → view 空間経由の対応が要る）。
2. **深度読み取りをフォーマット非依存に**（bytesPerSample で uint16/float32 判定）
   - 理由: 実機は luminance-alpha だが、将来 float32 でも同じ経路で扱えるように。
3. **`.hud` 子要素に可視スタイルを集約**
   - 理由: Phase 1 の実機スクショで、オーバーレイ内容が画面上部のブラウザ AR 表示と重なって見えた。dom-overlay ルートは UA が箱を制御するため、子要素で位置/背景/safe-area を持たせる方が予測可能。

### 検証

- ローカル: `tsc --noEmit` green、Vitest **19** green、`vite build` 成功。
- 未検証（実機）: R5（ヒートマップが動く目視確認）。→ `docs/PROGRESS.md` の手順で依頼。

---

## 2026-07-22 — インフラ: GitHub Pages 自動デプロイ

### 何を

- `.github/workflows/deploy-pages.yml` を追加。`main` への push で「テスト → ビルド → GitHub Pages へデプロイ」を自動実行。
- `vite.config.ts` に `VITE_BASE` 対応を追加（Pages のサブパス `/VoxelWorld/` で配信、ローカルは `/`）。
- `docs/ENVIRONMENT.md` の実機確認手順に「方法 A（最推奨・開発機不要）: GitHub Pages」を追加し、adb / mkcert / cloudflared を B〜D に繰り下げ。

### なぜ

- 実機確認で「github のページで開いたが何も表示されない」報告。原因は、リポジトリ画面や未ビルドの生ソースを開いていて **ビルド済みアプリが配信されていない**こと（本アプリは JS が動けば最低限ステータスカードを描画するため、完全な空白＝アセット未ロード＝配信/base 問題）。
- 恒久対策として、開発機や adb を要さず Pixel から URL を開くだけで確認できる HTTPS ホスティング（GitHub Pages）を用意するのが最善。WebXR の secure context 要件も HTTPS で満たす。
- PR #1 はマージ済みのため、本作業はブランチを `main` から作り直した新規 PR として起票（マージ済み履歴に積まない運用に準拠）。

### 検証

- ローカル: `tsc --noEmit` green、`VITE_BASE=/VoxelWorld/ vite build` がアセットを `/VoxelWorld/assets/...` に解決、ワークフロー YAML の妥当性を確認。
- 未検証: 実際の Actions 実行と Pages 公開 URL の応答（マージ後に GitHub MCP で監視・確認する）。

---

## 2026-07-22 — Phase 1: 環境確認ページ

### 何を

- Vite 6 + TypeScript 5.9(strict) + three.js 0.185 の足場を構築。バージョンを `package.json`/lock に固定。
- WebXR 能力判定 `src/xr/capabilities.ts`（`evaluateXRSupport` 純関数 + `probeXRSupport`）。
- AR セッション構築 `src/xr/session.ts`（`buildSessionInit` = depth-sensing 必須 / camera-access・dom-overlay 任意 / cpu-optimized+luminance-alpha 優先）と、深度・カメラの各プローブ。
- プローブ UI `src/main.ts` + `src/ui/*`：対応判定カード、開始ボタン、dom-overlay のライブパネル（`depthUsage`/`depthDataFormat`/`enabledFeatures`/深度解像度/`rawValueToMeters`/`camera-access` を ~4Hz 更新）、エラーの可視化。
- Vitest 11 件（capabilities 6 + session 5）。型チェック・ビルド・dev サーバ起動を確認。

### 主要な判断とその理由

1. **セッションを自前 `requestSession` → `renderer.xr.setSession()`**（ARButton 不使用）
   - 理由: three.js の ARButton は `depthSensing` 設定を注入しないため。調査どおり。
2. **WebXR 型に依存しすぎない防御的アクセス**（`session.ts` は独自の構造型 + `unknown` 経由）
   - 理由: `@types/webxr` のバージョン差で depth/camera 型の有無が揺れるため。値を実消費する Phase 3 で厳密型に置き換える。
3. **ESLint は今は入れない**（strict tsc + Prettier で担保）
   - 理由: flat-config のバージョン摩擦を避け、Phase 1 を確実に green にするため。必要になった段階で追加。
4. **camera-access は optionalFeature**
   - 理由: 色は要件だが、権限拒否でセッションごと失敗させたくない（幾何だけでも開始できるように）。

### 私が検証した / できていないこと

- 検証済み（本環境）: `tsc --noEmit` green、Vitest 11 件 green、`vite build` 成功、dev サーバが 200 で index/TS を配信。
- 未検証（実機必須）: R1〜R4（`depth-sensing` 実対応 / `depthUsage` / `depthDataFormat` / 深度解像度・`rawValueToMeters`）と R7（camera-access）。→ `docs/PROGRESS.md` の手順で依頼。

---

## 2026-07-22 — Phase 0: 事前調査

### 何を

- `docs/` を作成し、`RESEARCH.md` / `ENVIRONMENT.md` / `PROGRESS.md` / `HISTORY.md` を追加。
- Section 4 の 7 調査項目 + カメラ色取得（camera-access）を一次情報で調査。

### 主要な判断とその理由

1. **深度は `cpu-optimized` + `luminance-alpha` を第一候補**
   - 理由: ボクセル化は CPU で行うため CPU パスが自然。`luminance-alpha` は唯一サポート保証されるフォーマット。値は `raw * rawValueToMeters` で扱えばフォーマット非依存にできる。
   - リスク対策: 端末が `gpu-optimized` しか許さない場合の GPU readback 経路を設計に含める（実機 R2 で確認）。
2. **深度はカメラ主軸の垂直距離（eye-space Z）と確定**
   - 理由: ARCore 公式 + depth-sensing 原案 explainer が「レイ長ではない」と明記。逆投影は「レイ方向を垂直 Z でスケール」で実装する。
3. **色取得には `camera-access` が必須と判明（要件と base API の差分）**
   - 理由: `immersive-ar` 単体ではカメラ画素にアクセスできない。`getCameraImage()` は GPU テクスチャのみ。CPU 蓄積で色を使うには 1 フレーム 1 回の低解像度 readback が要る。→ Phase 3 のスコープに影響するため要判断事項として明示。
4. **表示は InstancedMesh、GLB 出力は greedy meshing 済みマージメッシュ + 頂点カラー、と役割分離**
   - 理由: InstancedMesh の instanceColor は glTF に素直に運べない。表示速度（Instanced）と出力互換（マージ + 頂点カラー）を分ける方が両立する。
5. **セッションは自前で `requestSession` して `renderer.xr.setSession()` に渡す**
   - 理由: three.js の `ARButton` は `depthSensing` 設定を注入しないため、`depthSensing`/`camera-access` を確実に含めるには自前構築が必要。
6. **three.js は r185 系で固定予定**
   - 理由: 2026-07 時点の最新安定（`three@0.185.x`）。

### 未確定 / 持ち越し

- 逆投影の y 規約と実寸スケールは実機キャリブレーション（R6）で確定。
- `.vox` 複数モデルのワールド配置（拡張チャンク）は MVP スコープ外候補。
