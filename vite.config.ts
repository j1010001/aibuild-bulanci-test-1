import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  server: {
    // No hardcoded port: respects the PORT env var so the dev server can be assigned
    // a free port when 5173 is already taken by another session.
    port: Number(process.env.PORT) || 5173,
    strictPort: false,
  },
});
