import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: { port: Number(process.env.SKYTHREAD_DEV_PORT) || 5173, strictPort: true, host: '127.0.0.1' },
  preview: { port: 4173, strictPort: true, host: '127.0.0.1' },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
    sourcemap: false,
  },
});
