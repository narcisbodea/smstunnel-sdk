import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    format: ['cjs', 'esm'],
    dts: true,
    outDir: 'dist',
    clean: true,
    sourcemap: true,
  },
  {
    entry: { 'server/index': 'src/server/index.ts' },
    format: ['cjs', 'esm'],
    dts: true,
    outDir: 'dist',
    sourcemap: true,
    external: ['@nestjs/common', '@nestjs/core', 'reflect-metadata'],
  },
  {
    entry: { 'react/index': 'src/react/index.ts' },
    format: ['cjs', 'esm'],
    dts: true,
    outDir: 'dist',
    sourcemap: true,
    external: ['react', 'react-dom'],
    esbuildOptions(options) {
      options.jsx = 'automatic';
    },
  },
  {
    entry: { 'vue/index': 'src/vue/index.ts' },
    format: ['cjs', 'esm'],
    dts: true,
    outDir: 'dist',
    sourcemap: true,
    external: ['vue'],
  },
  {
    entry: { 'node/index': 'src/node/index.ts' },
    format: ['cjs', 'esm'],
    dts: true,
    outDir: 'dist',
    sourcemap: true,
    platform: 'node',
    target: 'node18',
  },
  {
    entry: { 'angular/index': 'src/angular/index.ts' },
    format: ['cjs', 'esm'],
    dts: true,
    outDir: 'dist',
    sourcemap: true,
    external: ['@angular/core', '@angular/common', 'rxjs'],
  },
]);
