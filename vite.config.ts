import { defineConfig } from 'vitest/config';

// WebXR requires a secure context. For on-device testing the recommended path is
// `adb reverse tcp:5173 tcp:5173` (localhost counts as secure — no cert needed).
// For LAN/tunnel testing, run mkcert and point server.https at the generated pem/key,
// or use `cloudflared tunnel --url http://localhost:5173`. See docs/ENVIRONMENT.md.
export default defineConfig({
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
