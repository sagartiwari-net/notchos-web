// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';

// The site is a static build: no adapter, no server code (WEB plan decision 2).
export default defineConfig({
  site: 'https://notch.sagartiwari.net',
  // 127.0.0.1 only. Binding 0.0.0.0 can raise the macOS firewall prompt.
  // The same host and port are used by `astro dev` and `astro preview`.
  server: { host: '127.0.0.1', port: 4312 },
  devToolbar: { enabled: false },
  compressHTML: true,
  build: { inlineStylesheets: 'auto' },
  integrations: [
    sitemap({
      filter: (page) => !page.includes('/thanks'),
    }),
  ],
  vite: {
    plugins: [tailwindcss()],
    // 4312 belongs to the site (API 4310, admin 4311). Fail instead of drifting to another port.
    server: {
      strictPort: true,
      // Same-origin /api → Fastify in local preview (nginx does this in production).
      proxy: { '/api': { target: 'http://127.0.0.1:4310', changeOrigin: true } },
    },
    preview: {
      strictPort: true,
      proxy: { '/api': { target: 'http://127.0.0.1:4310', changeOrigin: true } },
    },
  },
});
