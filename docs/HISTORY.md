# HISTORY — 変更履歴と判断の理由

> 新しいものを上に追記する。各エントリに「何を」「なぜ」を残す。

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
