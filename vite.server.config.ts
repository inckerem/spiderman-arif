import { defineConfig } from 'vite';

// Game server bundle: `vite build --config vite.server.config.ts` → dist-server/server.mjs.
// Vite's SSR build (rolldown) resolves the extensionless shared imports from
// src/ the same way as the client build; three is bundled (tree-shaken math),
// ws stays an external runtime dependency.
export default defineConfig({
  publicDir: false,
  logLevel: 'warn',
  ssr: { noExternal: ['three'], external: ['ws'], target: 'node' },
  build: {
    ssr: 'server/main.ts',
    outDir: 'dist-server',
    emptyOutDir: true,
    target: 'node22',
    sourcemap: false,
    minify: false,
    rollupOptions: { output: { entryFileNames: 'server.mjs', format: 'es' } },
  },
});
