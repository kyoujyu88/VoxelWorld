# ENVIRONMENT — 開発環境と実機確認手順

> 最終更新: 2026-07-22
> 状態: **Phase 1（環境確認）実装済み**。バージョンを固定した。実機確認（R1〜R4）は依頼中。

---

## 1. 技術スタック（Phase 1 で固定）

| 種別       | バージョン（固定）                            | 備考                                                            |
| ---------- | --------------------------------------------- | --------------------------------------------------------------- |
| ランタイム | Node.js `v22.22.2` / npm 10                   | 本コンテナで確認済み                                            |
| バンドラ   | Vite `6.4.3`                                  | dev/build/preview                                               |
| 言語       | TypeScript `5.9.3`（strict + noUnused*）      | `tsc --noEmit` で型チェック                                     |
| 3D         | three.js `0.185.1`（r185）                    | WebGLRenderer + `renderer.xr`                                   |
| 型         | `@types/three 0.185.1`, `@types/webxr 0.5.24` | WebXR 型定義                                                    |
| Format     | Prettier `3.9.6`                              | ESLint は必要になった段階で追加（現状は strict tsc + Prettier） |
| テスト     | Vitest `2.1.9`（node 環境）                   | 実機不要の純ロジックを担保                                      |

正確なバージョンは `package.json` / `package-lock.json` に固定済み。

### プロジェクト構成（Phase 1 時点）

```
index.html                  # エントリ HTML
src/
  main.ts                   # 起動・AR フロー・ライブパネル更新
  style.css                 # ダークテーマ + dom-overlay パネル
  xr/
    capabilities.ts         # evaluateXRSupport（純関数・テスト対象） / probeXRSupport
    session.ts              # buildSessionInit（純関数・テスト対象） / requestArSession / 各種プローブ
  ui/
    dom.ts                  # el() / clear() DOM ヘルパ
    probePanel.ts           # renderCapabilityStatus / renderKVTable
test/
  capabilities.test.ts      # 6 tests
  session.test.ts           # 5 tests
```

### スクリプト

| コマンド            | 内容                                       |
| ------------------- | ------------------------------------------ |
| `npm run dev`       | Vite 開発サーバ（`http://localhost:5173`） |
| `npm run build`     | `tsc --noEmit` → `vite build`              |
| `npm run typecheck` | 型チェックのみ                             |
| `npm run test`      | Vitest（`vitest run`）                     |
| `npm run format`    | Prettier 整形                              |

---

## 2. ローカル開発

```bash
npm install
npm run dev        # Vite 開発サーバ（既定 http://localhost:5173）
npm run build      # 本番ビルド
npm run preview    # ビルド成果物の確認
npm run test       # Vitest（実機不要のユニットテスト）
```

WebXR は **secure context 必須**。`localhost` は secure context 扱いなので、実機を `localhost` に見せられれば証明書は不要（下記 adb reverse を推奨）。

---

## 3. 実機確認手順（Pixel 9a / Android Chrome）

> **重要**: この開発はリモートコンテナ上で行われるため、**WebXR の実機動作は私（Claude）側では実行できない**。以下の手順で利用者（あなた）に実機確認を依頼する。各フェーズの完了条件のうち「実機確認」項目は、この手順で確認結果を返してほしい。

### 前提

- Pixel 9a に **Google Play 開発者サービス for AR（ARCore）** が入っていること（Chrome が必要時に導入を促す）。
- Chrome for Android（最新）。
- USB デバッグ有効（adb 経由の場合）。

### 方法 A（推奨）: `adb reverse` で localhost 転送

証明書不要で最も簡単。開発機に Android SDK Platform-Tools（adb）が必要。

```bash
# 開発機で dev サーバを起動
npm run dev            # http://localhost:5173

# Pixel を USB 接続し、ポートを転送
adb devices            # 端末が認識されているか確認
adb reverse tcp:5173 tcp:5173
```

- Pixel の Chrome で **`http://localhost:5173`** を開く（`localhost` なので secure context 扱い＝ WebXR 可）。
- 接続が切れたら `adb reverse tcp:5173 tcp:5173` を再実行。

### 方法 B: 自己署名 HTTPS（mkcert）

adb が使えない / 無線で試したいとき。

```bash
mkcert -install
mkcert localhost 192.168.x.x    # 開発機の LAN IP
# vite.config.ts の server.https に pem/key を指定して起動
npm run dev -- --host           # LAN に公開
```

- Pixel を同一 LAN に接続し `https://192.168.x.x:5173` を開く。証明書警告は mkcert のローカル CA を端末に入れて回避。

### 方法 C: Cloudflare Tunnel

外部公開して確認したいとき。

```bash
cloudflared tunnel --url http://localhost:5173
# 発行された https://<random>.trycloudflare.com を Pixel で開く
```

### 確認時に返してほしい情報

デバッグページ（Phase 1 で用意）に表示される以下をスクショまたはテキストで:

- `immersive-ar` / `depth-sensing` / `camera-access` の対応可否
- セッション確立後の `depthUsage` / `depthDataFormat`
- `depthInfo.width` × `height`、`rawValueToMeters`
- 実機の fps 表示

Chrome のリモートデバッグ（`chrome://inspect` を開発機で開く）でコンソールログも取得できる。

---

## 4. リモート環境についての注意

- 本セッションはリモート・コンテナ実行。**コンテナは一時的**なので、成果物はこまめに commit / push する。
- WebXR/カメラ/センサを要する確認は実機依存。私はビルド・型チェック・ユニットテスト・（可能なら）ヘッドレスや WebXR エミュレータでの論理確認までを担保し、実機項目は本ファイルの手順で依頼する。
