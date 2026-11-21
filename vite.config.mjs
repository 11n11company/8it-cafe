import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'frontend',
  plugins: [react()],
  define: {
    'import.meta.env.VITE_BACKEND_PORT': JSON.stringify(process.env.PORT || '5000'),
    'import.meta.env.VITE_BACKEND_URL': JSON.stringify(process.env.BACKEND_URL || '')
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.BACKEND_URL || `http://127.0.0.1:${process.env.PORT || 5000}`,
        changeOrigin: true,
        secure: false,
        timeout: 20000
      }
    }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true
  }
});
