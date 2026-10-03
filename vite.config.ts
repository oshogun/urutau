/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const apiTarget = 'http://127.0.0.1:' + (process.env.URUTAU_API_PORT ?? 8787)

// https://vite.dev/config/
export default defineConfig({
  // Relative asset paths, so the built app works under a PUBLIC_URL path prefix.
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
    // Proxy target for /api: the API server's port (PORT there, default 8787). scripts/dev.mjs
    // sets URUTAU_API_PORT from PORT; set it yourself when running `vite` alone.
    proxy: {
      '/api': { target: apiTarget },
      // The MCP endpoint is mounted at /mcp, outside /api. The key is a regex so /mcp-foo is not proxied.
      '^/mcp(/|$)': { target: apiTarget },
    },
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
