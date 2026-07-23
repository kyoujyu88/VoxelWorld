import { defineConfig } from 'vitest/config';

// WebXR requires a secure context. Easiest on-device paths:
//  - GitHub Pages (HTTPS): open https://<user>.github.io/VoxelWorld/ on the phone.
//  - `adb reverse tcp:5173 tcp:5173` (localhost counts as secure — no cert needed).
//  - mkcert HTTPS or `cloudflared tunnel --url http://localhost:5173`. See docs/ENVIRONMENT.md.

// The GitHub Pages workflow sets VITE_BASE (e.g. "/VoxelWorld/") so built assets resolve
// under the project sub-path. Local dev and local builds default to "/".
declare const process: { env: Record<string, string | undefined> };
const base = process.env.VITE_BASE ?? '/';

// Build stamp shown in the UI so a stale (cached) page is obvious at a glance.
const buildId = `${new Date().toISOString().slice(0, 16).replace('T', ' ')}Z`;

export default defineConfig({
  base,
  define: {
    __BUILD_ID__: JSON.stringify(buildId),
  },
  server: {
    host: true, // expose on LAN for mkcert / tunnel testing
    port: 5173,
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
