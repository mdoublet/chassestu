import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    // En local, l'API (wrangler dev) est servie sur le port 8787.
    proxy: { '/api': 'http://localhost:8787' },
  },
  test: {
    environment: 'node',
  },
});
