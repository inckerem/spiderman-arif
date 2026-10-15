import { defineConfig } from 'vite';

// The game server (npm run server:test) listens on 8787 in development;
// SKYTHREAD_SERVER_PORT points the /ws proxy elsewhere.
const wsProxy = {
  '/ws': { target: `ws://127.0.0.1:${Number(process.env.SKYTHREAD_SERVER_PORT) || 8787}`, ws: true },
};

export default defineConfig({
  base: './',
  server: { port: Number(process.env.SKYTHREAD_DEV_PORT) || 5173, strictPort: true, host: '127.0.0.1', proxy: wsProxy },
  preview: { port: 4173, strictPort: true, host: '127.0.0.1', proxy: wsProxy },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
    sourcemap: false,
  },
});
