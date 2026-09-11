import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  root: resolve('src/editor/integration/web'),
  plugins: [react()],
  build: {
    outDir: resolve('build/vivido-editor'),
    emptyOutDir: true,
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    rollupOptions: {
      input: resolve('src/editor/integration/web/index.html'),
    },
  },
});
