import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'web-ui',
  base: '/app/',
  plugins: [react()],
  build: {
    outDir: '../web/app',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
  },
});
