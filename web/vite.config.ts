// Dev: `npm run web:dev` serves on :5173 and proxies the API and WebSocket to the editor server on :7777.
// Build: `npm run web:build` writes web/dist, which the server serves at http://localhost:7777.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const server = 'http://127.0.0.1:7777';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': server, '/ws': { target: server, ws: true } },
  },
});
