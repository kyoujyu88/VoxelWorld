# HISTORY — 変更履歴と判断の理由

> 新しいものを上に追記する。各エントリに「何を」「なぜ」を残す。

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
