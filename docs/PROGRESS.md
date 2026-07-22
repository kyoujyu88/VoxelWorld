# PROGRESS — フェーズ進捗

> 最終更新: 2026-07-22
> 凡例: ✅ 完了(検証済) / 🟡 実装済(実機未確認) / 🔵 実装中 / ⬜ 未着手 / ⛔ ブロック中

| Phase | 内容                  | 状態 | 完了条件                                                  | 達成状況                                                                      |
| ----- | --------------------- | ---- | --------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 0     | 事前調査（Section 4） | ✅   | `docs/RESEARCH.md` に一次情報でまとめる                   | 完了。7 項目 + camera-access を調査。実機確認項目 R1〜R9 を洗い出し           |
| 1     | 環境確認ページ        | 🟡   | Pixel 9a Chrome で `depth-sensing` 利用可能と表示         | 実装完了。型/テスト(11)/ビルド/dev サーバ起動を確認。**実機 R1〜R4 確認待ち** |
| 2     | 深度の可視化          | ⬜   | 端末を動かすと深度が白黒で目視確認できる                  | 未着手                                                                        |
| 3     | ボクセル蓄積          | ⬜   | 部屋一周で形状が概ね正しく蓄積、二重壁が実用範囲          | 未着手                                                                        |
| 4     | 描画                  | ⬜   | 10 万ボクセルで 30fps 維持                                | 未着手                                                                        |
| 5     | 画面レイアウト        | ⬜   | 上でスキャンしつつ下で結果が育つのが同時に見える          | 未着手                                                                        |
| 6     | ボクセルサイズ可変    | ⬜   | 再スキャンなしで即再構成                                  | 未着手                                                                        |
| 7     | エクスポート          | ⬜   | GLB を three.js ビューア + 外部ツールで開き実寸・色を確認 | 未着手                                                                        |

---

## 未確認事項（実機依存） — 詳細は RESEARCH.md 末尾 R1〜R9

- R1: `immersive-ar` + `depth-sensing` supported か
- R2: `depthUsage` が `cpu-optimized` になるか（否なら GPU readback 経路）
- R3: `depthDataFormat`
- R4: 深度バッファ解像度・`rawValueToMeters`
- R5: 深度が動くと更新される目視確認
- R6: 逆投影の y 反転・実寸キャリブレーション
- R7: `camera-access` 許可と色整合
- R8: 10 万ボクセル 30fps
- R9: GLB の実寸・色の外部ツール確認

## 現在のブロッカー / 要判断

1. **Phase 1 実機確認待ち**: `adb reverse` 等で Pixel 9a から開き、R1〜R4（`depth-sensing` 可否 / `depthUsage` / `depthDataFormat` / 深度解像度・`rawValueToMeters`）の結果を返してほしい。手順は `docs/ENVIRONMENT.md` 3 節。
2. **色の方針（Phase 3）**: camera-access で実色を取る方針で確定（承認済み）。camera-access が実機で拒否/不安定なら高さカラーマップにフォールバック。

## Phase 1 実機確認手順（このコミットで動く）

1. 開発機で `npm install && npm run dev`
2. Pixel 9a を USB 接続し `adb reverse tcp:5173 tcp:5173`
3. Pixel の Chrome で `http://localhost:5173` を開く
4. 「AR 準備完了」と表示され、緑の OK バッジが出れば **R1 合格**
5. 「AR + 深度センシングを開始」を押し、権限を許可 → 端末をゆっくり動かす
6. 下部パネルの `depthUsage` / `depthDataFormat` / 深度バッファ解像度 / `rawValueToMeters` / `camera-access` の値をスクショまたはテキストで返す（R2〜R4, R7 の一次データ）
