import { defineConfig } from 'vite'
import { devtools } from '@tanstack/devtools-vite'

import { tanstackStart } from '@tanstack/react-start/plugin/vite'

import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const config = defineConfig({
  resolve: { tsconfigPaths: true },
  server: {
    // Local dev: proxy API calls to the compose-published hq-api (PRD §11).
    proxy: {
      '/api': {
        target: process.env.HQ_API_PROXY_TARGET ?? 'http://localhost:4000',
        changeOrigin: true,
      },
    },
  },
  plugins: [
    devtools(),
    tailwindcss(),
    // Static SPA output so the app can be served by the frontend's own Nginx
    // container (see nginx/nginx.conf and Dockerfile).
    tanstackStart({
      spa: {
        enabled: true,
        prerender: { enabled: true, crawlLinks: false, retryCount: 3 },
      },
    }),
    viteReact(),
  ],
})

export default config
