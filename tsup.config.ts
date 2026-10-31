import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    format: ['cjs', 'esm'],
    dts: true,
    outDir: 'dist',
    clean: true,
    sourcemap: false,
  },
  {
    entry: { 'server/index': 'src/server/index.ts' },
    format: ['cjs', 'esm'],
    dts: true,
    outDir: 'dist',
    sourcemap: false,
    external: ['@nestjs/common', '@nestjs/core', 'reflect-metadata'],
  },
  {
    entry: { 'react/index': 'src/react/index.ts' },
    format: ['cjs', 'esm'],
    dts: true,
    outDir: 'dist',
    sourcemap: false,
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
    sourcemap: false,
    external: ['vue'],
  },
  {
    entry: { 'node/index': 'src/node/index.ts' },
    format: ['cjs', 'esm'],
    dts: true,
    outDir: 'dist',
    sourcemap: false,
    platform: 'node',
    target: 'node18',
  },
  {
    entry: { 'angular/index': 'src/angular/index.ts' },
    format: ['cjs', 'esm'],
    dts: true,
    outDir: 'dist',
    sourcemap: false,
    external: ['@angular/core', '@angular/common', 'rxjs'],
  },
]);
