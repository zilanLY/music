import vue from '@vitejs/plugin-vue';
import { resolve } from 'path';
import AutoImport from 'unplugin-auto-import/vite';
import { NaiveUiResolver } from 'unplugin-vue-components/resolvers';
import Components from 'unplugin-vue-components/vite';
import { defineConfig } from 'vite';
import viteCompression from 'vite-plugin-compression';
import VueDevTools from 'vite-plugin-vue-devtools';

// 项目根目录（vite.config.ts 位于项目根目录）
const projectRoot = __dirname;

export default defineConfig({
  base: './',
  // 渲染进程源码位置
  root: resolve(projectRoot, 'src/renderer'),
  resolve: {
    alias: {
      '@': resolve(projectRoot, 'src/renderer'),
      '@renderer': resolve(projectRoot, 'src/renderer'),
      '@i18n': resolve(projectRoot, 'src/i18n')
    }
  },
  plugins: [
    vue(),
    viteCompression(),
    process.env.NODE_ENV === 'development' ? VueDevTools() : null,
    AutoImport({
      imports: [
        'vue',
        {
          'naive-ui': ['useDialog', 'useMessage', 'useNotification', 'useLoadingBar']
        }
      ]
    }),
    Components({
      resolvers: [NaiveUiResolver()]
    })
  ],
  build: {
    target: 'esnext',
    outDir: resolve(projectRoot, 'dist'),
    emptyOutDir: true,
  },
  publicDir: resolve(projectRoot, 'resources'),
  server: {
    host: '0.0.0.0',
    port: 2389,
    proxy: {
      // 开发时代理 API 请求到指定的 API 服务器
      '/api': {
        target: process.env.VITE_API || 'http://localhost:30488',
        changeOrigin: true,
        rewrite: (path) => path,
      },
    },
  },
});
