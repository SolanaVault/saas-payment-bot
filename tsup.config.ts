import { defineConfig } from 'tsup';

export default defineConfig({
  entry: [
    'src/bot.ts',
  ],
  format: ['esm'],
  splitting: false,
  sourcemap: true,
  minify: true,
  clean: true,
  dts: false,
  outDir: 'dist',
  target: 'esnext',
  platform: 'node',
  banner: {
    js: '#!/usr/bin/env node'
  },
  bundle: true,
  external: [],
});
