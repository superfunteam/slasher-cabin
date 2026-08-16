import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: false,
  },
  build: {
    target: 'esnext',
    sourcemap: true,
    chunkSizeWarningLimit: 2000,
  },
  assetsInclude: ['**/*.mp3', '**/*.ogg', '**/*.wav'],
});
