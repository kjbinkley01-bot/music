import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Strict CSP for the packaged app only (the dev server needs inline scripts for hot reload).
const csp: Plugin = {
  name: 'stemdeck-csp',
  apply: 'build',
  transformIndexHtml: (html) =>
    html.replace(
      '<head>',
      `<head>\n    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' blob:; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; media-src 'self' blob:; connect-src 'self' http://127.0.0.1:*" />`,
    ),
};

export default defineConfig({
  plugins: [react(), csp],
  base: './',
  server: { port: 5173, strictPort: true },
  build: { outDir: 'dist', target: 'chrome120', chunkSizeWarningLimit: 900 },
  test: { environment: 'node' },
});
