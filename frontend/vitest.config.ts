import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  envDir: './vitest-env',
  define: {
    'import.meta.env.VITE_API_BASE_URL': JSON.stringify('https://api.test.invalid'),
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
});