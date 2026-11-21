import { defineConfig } from 'vite'
import { devtools } from '@tanstack/devtools-vite'

import { tanstackStart } from '@tanstack/react-start/plugin/vite'

import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const config = defineConfig({
  resolve: { tsconfigPaths: true },
  // Local dev: proxy API calls to the outlet backend container's published
  // port (the generated clients are same-origin, baseURL /api/v1).
  server: {
    proxy: {
      '/api': {
        target: process.env.OUTLET_API_PROXY_TARGET ?? 'http://localhost:5000',
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
