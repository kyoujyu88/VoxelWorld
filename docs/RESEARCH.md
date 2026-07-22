# RESEARCH — WebXR ボクセルスキャナ 事前調査

> 担当: **Researcher**
> 最終更新: 2026-07-22
> 目的: Section 4 の調査タスクを一次情報で確認し、実装前提を確定する。
> 方針: バージョン依存の詳細は実装時に再確認する。実機（Pixel 9a / Android Chrome）で確認が必要な項目は末尾の「実機確認が必要な事項」に集約する。

---

## 0. エグゼクティブサマリ（確定した設計判断）

| 項目         | 判断                                                                                                                                                                                                          | 根拠                                                                                                        |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 深度取得     | WebXR Depth Sensing、**`cpu-optimized` + `luminance-alpha`** を第一候補で要求                                                                                                                                 | `luminance-alpha` のみが「サポート保証」される唯一のフォーマット。CPU 側でボクセル化するため CPU パスが自然 |
| 深度の意味   | **カメラ主軸に沿った垂直距離（eye-space の Z）**。レイ長ではない                                                                                                                                              | ARCore 公式 / depth-sensing 原案 explainer                                                                  |
| 逆投影       | `normDepthBufferFromNormView` の逆行列 → 正規化ビュー座標 → NDC → `projectionMatrix` の逆でレイ方向 → 垂直深度でスケール → `view.transform` でワールド化                                                      | depth-sensing explainer + ARCore の深度定義                                                                 |
| 色           | カメラ画像は **`camera-access` 機能が必須**。`getCameraImage()` は **GPU テクスチャのみ**（CPU 直読み不可）。色を CPU 蓄積に使うには 1 フレーム 1 回の低解像度 readback が要る                                | raw-camera-access explainer                                                                                 |
| レンダリング | three.js r185 で `renderer.xr.setSession()` にセッションを渡す。深度は自前で `frame.getDepthInformation(view)` から読む（three.js の `WebXRDepthSensing` はオクルージョン表示用で、値の取得用途には使わない） | three.js docs / ARButton ソース                                                                             |
| 画面分割     | `dom-overlay` で下半分に不透明 DOM を重ね、その中に別 canvas で俯瞰プレビュー                                                                                                                                 | dom-overlays explainer                                                                                      |
| 内部表現     | 2cm 固定グリッド、量子化整数キーのハッシュマップ（スパース）。表示/出力時に整数倍ダウンサンプル                                                                                                               | プロンプト設計要件 2-2                                                                                      |
| GLB          | `GLTFExporter`、頂点カラー（`COLOR_0`）、**greedy meshing + 内面カリング必須**。InstancedMesh のままではなくマージ済み `BufferGeometry` を出力                                                                | GLTFExporter docs                                                                                           |
| .vox         | RIFF 風チャンク、256³・256 色制限のためモデル分割 + パレット量子化。MagicaVoxel は Z-up なので軸変換が要る                                                                                                    | ephtracy 公式フォーマット仕様                                                                               |

---

## Q1. WebXR Depth Sensing Module の仕様と Chrome for Android の実装状況

### 仕様（W3C / immersive-web）

- 仕様: [WebXR Depth Sensing Module (W3C WD)](https://www.w3.org/TR/webxr-depth-sensing-1/) / [ED](https://immersive-web.github.io/depth-sensing/) / [explainer](https://github.com/immersive-web/depth-sensing/blob/main/explainer.md)
- `immersive-ar` セッションの機能として `depth-sensing` を要求する。要求時に **`depthSensing` 設定オブジェクト**を渡す:

```js
const session = await navigator.xr.requestSession('immersive-ar', {
  requiredFeatures: ['depth-sensing'],
  depthSensing: {
    usagePreference: ['cpu-optimized', 'gpu-optimized'], // 優先順
    dataFormatPreference: ['luminance-alpha', 'float32'], // 優先順
  },
});
// 実際に採用された構成を必ず確認する
session.depthUsage; // "cpu-optimized" | "gpu-optimized"
session.depthDataFormat; // "luminance-alpha" | "float32"
```

### `depthUsage`: `cpu-optimized` vs `gpu-optimized`

- **`cpu-optimized`** → `frame.getDepthInformation(view)` が `XRCPUDepthInformation` を返す。`data`（ArrayBuffer）を CPU から直接読める。
- **`gpu-optimized`** → `xrGlBinding.getDepthInformation(view)` が `XRWebGLDepthInformation` を返す。深度は **不透明テクスチャ**として渡され、CPU から直接は読めない（readback が必要）。
- **本プロジェクトの選択: `cpu-optimized`**。ワールド座標への逆投影とスパースグリッド蓄積を CPU で行うため。深度バッファは低解像度なので、毎フレーム CPU 読みしても負荷は小さい（下記解像度）。
- リスク: 端末によっては `cpu-optimized` が拒否され `gpu-optimized` にフォールバックする可能性がある。→ Phase 1 で `session.depthUsage` を実機確認し、`gpu-optimized` しか出ない場合は「深度テクスチャ → オフスクリーン FBO → `gl.readPixels`」のフォールバック経路を用意する（設計に含める）。

### `depthDataFormat`: `luminance-alpha` vs `float32`

- **`luminance-alpha`** — 2 バイト符号なし整数。CPU では `Uint16Array` として解釈。**唯一「サポート保証」されるフォーマット**（explainer 明記）。
  - GPU シェーダで復元する場合: `dot(texture(...).ra, vec2(255.0, 256.0*255.0)) * rawValueToMeters`（下位バイト=luminance, 上位バイト=alpha）。
- **`float32`** — 4 バイト浮動小数。CPU では `Float32Array`。精度は高いが対応は保証されない。
- **本プロジェクトの選択: `luminance-alpha` を第一希望**（互換性最優先）。値は常に `raw * rawValueToMeters`（メートル）で扱うため、内部処理はフォーマット非依存にできる。実機で `float32` が使えれば量子化誤差が減るので、`dataFormatPreference` には両方を順に入れておく。
  - `luminance-alpha`（16bit, mm オーダーの `rawValueToMeters`）でも 2cm ボクセルには十分。

### 深度バッファの実解像度

- 一次情報に「Pixel で必ず N×M」という記載は無い。ARCore 由来の WebXR 深度は**平滑化済みの低解像度バッファ**で、実測では 160×90 前後のオーダー（横持ち基準）とされる。
- **確定値は実行時に `depthInfo.width` / `depthInfo.height` をログして得る**（Phase 1 の実機確認項目）。設計は解像度非依存にし、サブサンプリング率をパラメータ化する。

### Chrome for Android 実装状況

- WebXR Depth Sensing は Chrome for Android + ARCore 対応端末で**出荷済み機能**。Pixel 9a は ARCore 対応・ToF 無し → depth-from-motion で深度が出る（プロンプト前提どおり）。
- ARCore の depth-from-motion は**端末を動かさないと深度が生成されない**、特徴の乏しい面（白壁など）で欠損する、有効範囲 0〜65m・高精度帯 0.5〜5m（プロンプト記載の前提と一致）。

出典: [W3C WD](https://www.w3.org/TR/webxr-depth-sensing-1/), [explainer](https://github.com/immersive-web/depth-sensing/blob/main/explainer.md), [MDN XRSession.depthUsage](https://developer.mozilla.org/en-US/docs/Web/API/XRSession/depthUsage), [MDN XRSession.depthDataFormat](https://developer.mozilla.org/en-US/docs/Web/API/XRSession/depthDataFormat), [Chrome Platform Status: Depth Sensing Perf](https://cr-status.appspot.com/feature/5074096916004864)

---

## Q2. three.js における深度センシングの扱い

- three.js のバージョン: **r185（`three@0.185.x`）が最新安定**（2026-07 時点、npm `three` 0.185.1）。本プロジェクトは r185 系で固定する（実装時に最終確認）。
- three.js には `WebXRDepthSensing`（`examples/jsm/webxr/`）があるが、これは**環境深度テクスチャで仮想オブジェクトをオクルージョンする表示用**の仕組み。**深度値を取り出して点群化する用途には使わない。**
- three.js の `ARButton` は **`depthSensing` 設定を注入しない**（ソース確認済み。`dom-overlay` のみ自動付与）。したがって:
  - **セッションは自前で `navigator.xr.requestSession()` して構築し、`renderer.xr.setSession(session)` で three.js に渡す**（または `ARButton.createButton(renderer, sessionInit)` に自前の `sessionInit` を渡す。ただし `depthSensing` を確実に含めるため前者を採る）。
- 深度読み取りは three.js のレンダーループから:

```js
renderer.xr.setReferenceSpaceType('local'); // or "local-floor"
renderer.setAnimationLoop((time, frame) => {
  if (!frame) return;
  const refSpace = renderer.xr.getReferenceSpace();
  const pose = frame.getViewerPose(refSpace);
  if (!pose) return;
  for (const view of pose.views) {
    const depthInfo = frame.getDepthInformation(view); // XRCPUDepthInformation
    if (!depthInfo) continue;
    // depthInfo.width/height/data/rawValueToMeters/normDepthBufferFromNormView
    // view.projectionMatrix, view.transform.matrix, view.transform.inverse.matrix
  }
  renderer.render(scene, camera); // three.js が XR カメラを更新
});
```

- 注意: 既知の three.js issue（`WebXRDepthSensing can result in invalid projectionMatrix (NaN)`）があるため、`WebXRDepthSensing` 表示機能には依存しない方針は妥当。

出典: [WebXRDepthSensing docs](https://threejs.org/docs/pages/WebXRDepthSensing.html), [three.js releases](https://github.com/mrdoob/three.js/releases), [ARButton.js (dev)](https://github.com/mrdoob/three.js/blob/dev/examples/jsm/webxr/ARButton.js), [issue #29098](https://github.com/mrdoob/three.js/issues/29098)

---

## Q3. `dom-overlay` の制約（Android Chrome / ハンドヘルド AR）

- 仕様: [WebXR DOM Overlays Module](https://www.w3.org/TR/webxr-dom-overlays-1/) / [explainer](https://github.com/immersive-web/dom-overlays/blob/main/explainer.md)
- ハンドヘルド AR では Chrome for Android 82+ で対応。要求は `optionalFeatures: ["dom-overlay"]` + `domOverlay: { root: <element> }`。
- **オーバーレイのルートは 1 つ**（単一要素）。その要素とその子孫が AR コンポジット映像の**上に合成**される。→ 下半分パネルはこのルート DOM 内に配置する。
- **入力**: オーバーレイ矩形に当たったタッチは DOM の `click`（必須）/ `pointerdown/move/up`（任意対応）として DOM に転送される。同時に WebXR の transient-pointer 入力（画面タップ）も発生しうるので、**下半分 UI の操作が AR の select と二重発火しない**よう、UI 要素側で `pointerdown`/`click` を捕捉し `stopPropagation()` する。
- **クロスオリジン制約**: オーバーレイにクロスオリジン内容（iframe 等）があると、その上での操作中は WebXR 入力・コントローラ姿勢がブロックされる。→ オーバーレイは**同一オリジンの自前 DOM のみ**にする（iframe 等を入れない）。
- **CSS の制約**: オーバーレイは全画面合成の一部。`overflow`/`transform` などで凝ったレイアウトをすると環境差が出るため、下半分パネルは素直な `position: fixed; bottom:0; height:50vh` 系で構成する。背景は不透明にして AR 映像を隠す。
- **2 つの WebGL コンテキスト**: 上半分（XR, three.js WebGLRenderer）と下半分（俯瞰プレビュー用の別 canvas/WebGL）で GL コンテキストが 2 つになる。→ 下側は**解像度を落とし更新 10fps 程度に間引く**（プロンプト要件どおり）。俯瞰は軽量なので `WebGLRenderer` を共有せず専用の小さいレンダラを持つ。

出典: [W3C DOM Overlays](https://www.w3.org/TR/webxr-dom-overlays-1/), [explainer](https://github.com/immersive-web/dom-overlays/blob/main/explainer.md), [Intent to Implement (Chromium)](https://groups.google.com/a/chromium.org/g/blink-dev/c/QRbZ0ZUjhmI/m/kdS3S9OtAgAJ)

---

## Q4. `GLTFExporter` の対応範囲（頂点カラー / InstancedMesh）

- **頂点カラー**: `BufferGeometry` の `color` 属性（`COLOR_0`）は glTF に出力される。RGB / RGBA 対応。→ ボクセル色は**頂点カラーで保持**する方針（マージ済みメッシュに各面の色を頂点カラーとして焼き込む）。
- **InstancedMesh**: `GLTFExporter` は InstancedMesh を `EXT_mesh_gpu_instancing` 拡張として出力できるが、**インスタンスごとの色（`instanceColor`）は glTF 標準では素直に運べない**／取り込み側の対応もまちまち。
  - → **エクスポートは InstancedMesh のままにしない**。greedy meshing でマージした単一（またはチャンク分割した数個の）`Mesh` + 頂点カラーとして出力する。これがポリゴン数・色・互換性のすべてで最良。
  - InstancedMesh は**画面表示（スキャン中の高速描画）専用**、GLB 出力は**マージ済みメッシュ**、と役割を分離する。
- テクスチャアトラス案も可能だが、まず頂点カラーで実装（実寸・色の保持が要件、頂点カラーで満たせる）。必要なら後段でアトラス化。

出典: [GLTFExporter docs](https://threejs.org/docs/#examples/en/exporters/GLTFExporter), [three.js forum: InstancedMesh export](https://discourse.threejs.org/t/blender-export-instancedmesh-directly/73769)

---

## Q5. greedy meshing（ボクセル向け）

- 定番の解説と実装: **Mikola Lysenko "Meshing in a Minecraft Game"**（[0fps.net](https://0fps.net/2012/06/30/meshing-in-a-minecraft-game/)）と JS 実装 [mikolalysenko/greedy-mesher](https://github.com/mikolalysenko/greedy-mesher)。参考 C/Java 実装: [roboleary/GreedyMesh](https://github.com/roboleary/GreedyMesh)、解説: [Meshing in Voxel Engines (blackflux)](https://blackflux.wordpress.com/2014/02/23/meshing-in-voxel-engines-part-1/)。
- アルゴリズム要点:
  1. 6 方向（±X, ±Y, ±Z）それぞれについて、軸に垂直なスライスを 1 枚ずつ走査する。
  2. 各スライスで「面が露出している（隣接ボクセルが空）かつ色が同じ」セルを 2D マスクにする。
  3. マスク上で**最大の長方形**を貪欲に取り、1 枚の quad にまとめる。取った領域はマスクから消す。
  4. これを全スライスで繰り返す。
- **内面カリング**は greedy meshing の前提そのもの: 隣接ボクセルが埋まっている面は quad を生成しない（露出面のみ）。これで内部の面が消え、表面だけが残る。
- **色の扱い**: マージ条件に「色が同一」を加える（色ごとに面を分ける）。色は quad の 4 頂点に頂点カラーとして付与。ダウンサンプル後のボクセル色でマージするので面数は実用範囲に収まる。
- 本プロジェクトは自前実装（スパースグリッド → 表示解像度で密ボクセル配列化 → 6 方向スライスで greedy）。外部ライブラリは仕様把握のため参照するが依存はしない。

出典: [0fps.net](https://0fps.net/2012/06/30/meshing-in-a-minecraft-game/), [mikolalysenko/greedy-mesher](https://github.com/mikolalysenko/greedy-mesher), [roboleary/GreedyMesh](https://github.com/roboleary/GreedyMesh)

---

## Q6. MagicaVoxel `.vox` フォーマット仕様

- 一次情報: [ephtracy/voxel-model `MagicaVoxel-file-format-vox.txt`](https://github.com/ephtracy/voxel-model/blob/master/MagicaVoxel-file-format-vox.txt)（拡張は `...-vox-extension.txt`）。RIFF 風構造。
- 全体構造:
  - ヘッダ: `'V' 'O' 'X' ' '`（4 byte）+ `version`（int32, **150**）
  - `MAIN` チャンク（ルート）: content 0 byte、children にモデル群とパレット
- **チャンク共通フォーマット**（すべてリトルエンディアン）:

  | フィールド           | 型      | 説明                                                |
  | -------------------- | ------- | --------------------------------------------------- |
  | chunk id             | char[4] | 例 `'SIZE'`, `'XYZI'`, `'RGBA'`, `'PACK'`, `'MAIN'` |
  | numBytesContent (N)  | int32   | 本体バイト数                                        |
  | numBytesChildren (M) | int32   | 子チャンク合計バイト数                              |
  | content              | byte[N] | 本体                                                |
  | children             | byte[M] | 子チャンク                                          |

- `PACK`（任意）: content = `int32 numModels`。無ければモデル数 1。
- `SIZE`: `int32 x, int32 y, int32 z`（z が重力方向 = 上方向）。**1 モデルあたり各軸 ≤ 256**。
- `XYZI`: `int32 numVoxels` の後、各ボクセル 4 byte = `(x:u8, y:u8, z:u8, colorIndex:u8)`。
- `RGBA`（任意）: 256 エントリ × `(r:u8, g:u8, b:u8, a:u8)`。
  - **重要**: ボクセルの `colorIndex ∈ [1,255]` は配列 `palette[colorIndex - 1]` を指す（1 始まり）。書き出し時は色を配列 0..254 に置き、参照は 1..255。
  - `RGBA` 省略時はデフォルト 256 色パレットが使われる。→ 本プロジェクトは常に `RGBA` を書く。
- **座標系**: MagicaVoxel は **Z-up**。WebXR/three.js は **Y-up**。→ 出力時に軸変換（`vox.z = webxr.y`, `vox.y = -webxr.z` など、右手/左手も含め実装時に確定）。
- **制限対応**（プロンプト要件）: 256³ 超・256 色超は、
  - **モデル分割**: バウンディングを 256 ボクセル格子で分割し複数 `SIZE`/`XYZI` を出力（各モデルにオフセットは拡張チャンク `nTRN`/`nGRP`/`nSHP` で持たせるか、原点情報を生グリッド側に持たせる）。
  - **パレット量子化**: 色を 255 色に量子化（median-cut など）。
- 注意: 単純な複数モデルの**ワールド配置**には拡張チャンク（`nTRN`/`nGRP`/`nSHP`/`LAYR`）が要る。MVP では「原点は生グリッドが正」とし、.vox は各モデルをローカル原点で出す + 位置は生グリッド/ドキュメントで補完。完全配置は必要になった時点で拡張チャンク対応。

出典: [ephtracy 公式仕様](https://github.com/ephtracy/voxel-model/blob/master/MagicaVoxel-file-format-vox.txt), [Kaitai Struct 定義](https://formats.kaitai.io/magicavoxel_vox/)

---

## Q7. 深度 → ワールド座標 逆投影（最重要）

### 深度値の定義（確定）

- WebXR/ARCore の深度は **カメラ平面からの垂直距離（eye-space の Z 距離）**。ピクセルへ向かうレイの長さ（Euclidean 距離）ではない。
  - depth-sensing 原案 explainer: 「returned depth value is a distance from the camera plane ... it is **not the length of vector aA**」
  - ARCore 公式: 「principal axis に射影した z 座標。レイ長ではない」

### 利用可能な行列・値（各 `view` について）

- `depthInfo = frame.getDepthInformation(view)`（`XRCPUDepthInformation`）
  - `.width` `.height` `.data`（`luminance-alpha` → `Uint16Array`）`.rawValueToMeters`
  - `.normDepthBufferFromNormView`（`XRRigidTransform`）: 正規化ビュー座標 → 正規化深度バッファ座標 への変換。`.inverse.matrix` で逆変換。
- `view.projectionMatrix`（`Float32Array` column-major）: eye 空間 → clip
- `view.transform.matrix`: eye 空間 → 参照（ワールド）空間（= カメラ姿勢）
- `view.transform.inverse.matrix`: ワールド → eye

### 逆投影手順（テクセル (c,r) → ワールド点）

```
d = raw[c + r*W] * rawValueToMeters            // 垂直深度[m]。0 は欠損 → skip
                                                // d < dMin(0.3) or d > dMax(5〜8) も skip
ndb = [ (c+0.5)/W, (r+0.5)/H, 0, 1 ]            // テクセル中心の正規化深度バッファ座標
nv  = inverse(normDepthBufferFromNormView) * ndb // 正規化ビュー座標 (nv.x,nv.y ∈ [0,1])
ndc = [ nv.x*2 - 1, (1 - nv.y)*2 - 1 ]         // NDC。y は上下反転（要実機確認）
clip = [ ndc.x, ndc.y, -1, 1 ]                 // near 面の clip 点
eyeH = inverse(projectionMatrix) * clip
dir  = eyeH.xyz / eyeH.w                        // eye 空間でのピクセル方向（-Z 前方）
t    = -d / dir.z                               // eye-space Z の大きさを d に一致させる
pEye = dir * t                                  // eye 空間の 3D 点（pEye.z == -d）
pWorld = view.transform.matrix * [pEye, 1]      // ワールド座標
voxelKey = quantize(pWorld / 0.02)              // 2cm 量子化
```

- `getDepthInMeters(x, y)`（正規化座標 x,y ∈ [0,1] を取る便利 API）も存在するが、**密な再構成では生バッファを直接走査**する方が速い。逆投影の検証には両者を突き合わせられる。
- **要実機確認の 2 点**（Phase 3 でキャリブレーション）:
  1. NDC への変換で **y 反転が正しい向きか**（深度バッファ原点が左上、`normDepthBufferFromNormView` の規約に依存）。
  2. 既知距離（例: 1.0m 前方の壁）にターゲットを置き、再構成点が実寸で一致するか。ズレれば y 反転 / スケール / 深度の垂直 vs レイ解釈を再点検。

出典: [depth-sensing explainer](https://github.com/immersive-web/depth-sensing/blob/main/explainer.md), [bialpio 原案 explainer](https://github.com/bialpio/webxr-depth-api/blob/master/explainer.md), [immersive-web/depth-sensing issue #37 (normDepthBufferFromNormView)](https://github.com/immersive-web/depth-sensing/issues/37), [ARCore depth developer guide](https://developers.google.com/ar/develop/java/depth/developer-guide), [MDN XRWebGLBinding.getDepthInformation](https://developer.mozilla.org/en-US/docs/Web/API/XRWebGLBinding/getDepthInformation)

---

## 追加調査: カメラ画像からの色サンプリング（要件 2-1）

- 要件「各ボクセルはカメラ画像から色をサンプリング」は、**base の `immersive-ar` だけでは実現できない**。カメラ画素へのアクセスには **WebXR Raw Camera Access（`camera-access` 機能）**が必要。
- API: `view.camera`（`XRCamera`, `.width/.height`）→ `binding.getCameraImage(view.camera)` が **`WebGLTexture`** を返す。
  - **GPU テクスチャのみ**。CPU 直読み不可。フレーム内でのみ有効。`XRView` と**画素整合が保証**（同じ射影・姿勢）。
  - **権限プロンプト**が出る（プライバシー）。
- CPU 蓄積で色を使う実装:
  1. 毎フレーム、カメラテクスチャを**低解像度のオフスクリーン FBO に描画**し `gl.readPixels` で CPU バッファ化（1 フレーム 1 回、小さいサイズ）。
  2. 深度テクセルの正規化ビュー座標 `nv` は**カメラ画像の UV と一致**するので、`(nv.x*camW, nv.y*camH)` で色を引く。
  3. ボクセルに色を**移動平均**で累積。
- 代替（色を後回しにする場合）: 高さ/法線ベースのカラーマップで幾何を先に固める → 後で camera-access 色に差し替え。**この選択は Phase 3 のスコープに影響する（下記「実機確認/要判断」参照）**。

出典: [raw-camera-access explainer](https://github.com/immersive-web/raw-camera-access/blob/main/explainer.md), [MDN XRWebGLBinding.getCameraImage](https://developer.mozilla.org/en-US/docs/Web/API/XRWebGLBinding/getCameraImage)

---

## 実機（Pixel 9a）確認が必要な事項 — 一覧

| #   | 確認内容                                                                                 | 確認するフェーズ |
| --- | ---------------------------------------------------------------------------------------- | ---------------- |
| R1  | `immersive-ar` + `depth-sensing` が supported と出るか                                   | Phase 1          |
| R2  | `session.depthUsage` が `cpu-optimized` になるか（ならなければ GPU readback 経路が必要） | Phase 1          |
| R3  | `session.depthDataFormat`（`luminance-alpha` / `float32`）                               | Phase 1          |
| R4  | `depthInfo.width` / `height` の実値と `rawValueToMeters`                                 | Phase 1/2        |
| R5  | 深度が動くと更新され、近い物ほど明るい等が目視で確認できる                               | Phase 2          |
| R6  | 逆投影の y 反転・スケールが正しい（既知距離ターゲットで実寸一致）                        | Phase 3          |
| R7  | `camera-access` の許可が通り、色が整合して取れるか                                       | Phase 3          |
| R8  | 10 万ボクセルで 30fps 維持                                                               | Phase 4          |
| R9  | 書き出した GLB が実寸・色を保って外部ツールで開けるか                                    | Phase 7          |

---

## 未解決点・注意（誤魔化さず記録）

1. **深度の垂直 Z 解釈**は一次情報で確定だが、`normDepthBufferFromNormView` の y 規約（左上/左下原点）と NDC 反転は実機キャリブレーションで最終確定する（R6）。推測のまま先に進めない。
2. **`cpu-optimized` が全端末で保証されない**。Pixel 9a で拒否された場合の GPU readback 経路を設計に含める（R2）。
3. **色の camera-access** は権限・整合・性能の追加コストがある。MVP で色を先送りするか本実装するかは要判断（Phase 3 冒頭で確定）。
4. **`.vox` の複数モデルのワールド配置**（`nTRN` 等の拡張チャンク）は MVP スコープ外候補。原点は生グリッドを正とする。
5. **本環境（リモート・コンテナ）では実機 WebXR を私が実行できない**。上表 R1〜R9 は手順を明示して依頼する（`docs/ENVIRONMENT.md` に手順）。
