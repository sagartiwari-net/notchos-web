import { fileURLToPath, URL } from 'node:url'

import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type ProxyOptions } from 'vite'

// Local ports (NOTCHOS-WEB-PLAN.md section 10): API 4310, admin 4311.
const HOST = '127.0.0.1'
const ADMIN_PORT = 4311
const API_ORIGIN = 'http://127.0.0.1:4310'

// Browser → Vite → API /admin/*.
// Local default API_BASE is /api. Production same-host build uses /admin-api (see reset-server).
const apiProxy: Record<string, ProxyOptions> = {
  '/api': {
    target: API_ORIGIN,
    rewrite: (path) => path.replace(/^\/api(?=\/|$)/, '/admin'),
  },
  '/admin-api': {
    target: API_ORIGIN,
    rewrite: (path) => path.replace(/^\/admin-api(?=\/|$)/, '/admin'),
  },
}

// Same-domain deploy serves the SPA under /admin/ (see deploy/nginx). Local stays at /.
const BASE = process.env.ADMIN_BASE ?? '/'

// https://vite.dev/config/
export default defineConfig({
  base: BASE,
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  // 127.0.0.1 only (never 0.0.0.0), and fail instead of moving to another port.
  server: {
    host: HOST,
    port: ADMIN_PORT,
    strictPort: true,
    proxy: apiProxy,
  },
  preview: {
    host: HOST,
    port: ADMIN_PORT,
    strictPort: true,
    proxy: apiProxy,
  },
  build: {
    rolldownOptions: {
      output: {
        // Libraries go into their own files. They change far less often than the admin's own
        // code, so a deploy that only touches the admin leaves them cached in the browser.
        codeSplitting: {
          groups: [
            {
              name: 'react',
              test: /node_modules[\\/](react|react-dom|scheduler|react-router|@remix-run)[\\/]/,
              priority: 30,
            },
            {
              name: 'radix',
              test: /node_modules[\\/](radix-ui|@radix-ui|@floating-ui)[\\/]/,
              priority: 20,
            },
            { name: 'vendor', test: /node_modules[\\/]/, priority: 10 },
          ],
        },
      },
    },
  },
})
