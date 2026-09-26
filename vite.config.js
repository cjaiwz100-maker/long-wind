import { defineConfig } from 'vite';

export default defineConfig({
  base: './',   // relative URLs: the build works from any sub-path (GitHub Pages /<repo>/)
  server: { port: 5173, strictPort: true, host: '127.0.0.1' },
  build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
});
