import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:3001',
      '/health': 'http://127.0.0.1:3001',
      '/grok-test-media': { target: 'http://127.0.0.1:3001', ws: true },
    },
  },
  build: { chunkSizeWarningLimit: 600 },
});
