/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  // Relative base so the static build works from any sub-path (e.g. GitHub Pages).
  base: './',
  plugins: [react()],
  build: {
    rolldownOptions: {
      output: {
        // Keep the big, rarely changing libraries in their own long-cached chunks.
        codeSplitting: {
          groups: [
            { name: 'carbon', test: /node_modules[\\/]@carbon[\\/]/, priority: 2 },
            { name: 'vendor', test: /node_modules[\\/]/, priority: 1 },
          ],
        },
      },
    },
  },
  server: {
    // The API server (npm run dev:server) listens on URUTAU_API_PORT, default 8787.
    proxy: { '/api': { target: 'http://127.0.0.1:' + (process.env.URUTAU_API_PORT ?? 8787) } },
  },
  css: {
    preprocessorOptions: {
      scss: {
        // Carbon's Sass still uses syntax that newer Sass versions flag as
        // deprecated; keep those warnings out of our build output.
        quietDeps: true,
      },
    },
  },
  test: {
    restoreMocks: true,
    unstubGlobals: true,
    projects: [
      {
        extends: true,
        test: {
          name: 'client',
          environment: 'jsdom',
          include: ['src/**/*.test.{ts,tsx}'],
          setupFiles: ['./src/test/setup.ts'],
        },
      },
      {
        extends: true,
        test: { name: 'server', environment: 'node', include: ['server/**/*.test.ts'] },
      },
    ],
  },
})
