# Vercel 部署指南

## 架构

```
Vercel 同一项目
├── 前端 (Vue 3 SPA)   → 静态文件，输出到 /dist
└── API (Node.js)     → Serverless Functions，输出到 /api
     └── netease-cloud-music-api-alger (自动 npm install)
```

所有请求 → `/api/*` → NeteaseCloudMusicApi  
所有其他请求 → `/*` → Vue SPA

## 部署步骤

### 1. Fork 项目到 GitHub

```bash
git clone https://github.com/algerkong/AlgerMusicPlayer.git
git remote set-url origin https://github.com/你的用户名/AlgerMusicPlayer.git
git push -u origin main
```

### 2. Vercel 导入

1. 访问 [vercel.com](https://vercel.com) → New Project
2. Import 你的 GitHub 仓库
3. Framework Preset: `Other`
4. **Root Directory**: `.`（保持默认）
5. **Build Command**: `npm install && npm run build:web`
6. **Output Directory**: `dist`

### 3. 环境变量（可选）

在 Vercel Dashboard → Settings → Environment Variables 中配置：

| 变量名 | 值 | 说明 |
|--------|-----|------|
| `VITE_API` | `/api` | 同域名下留空即可 |
| `VITE_API_MUSIC` | `/api` | 同域名下留空即可 |
| `VITE_VERCEL` | `true` | 标记 Vercel 环境 |

> **重要**：`VITE_API` 和 `VITE_API_MUSIC` 留空即可！前端会自动使用同域名的 `/api` 路径，无需额外配置。

### 4. Deploy

点击 Deploy！等待约 2-3 分钟完成。

部署完成后访问：`https://你的项目.vercel.app`

## 本地开发测试

```bash
npm install
npm run dev:web
```

> 本地开发时，Vite dev server 的代理会把 `/api` 请求转发到 `localhost:30488`（桌面版的本地 API）。  
> 如果只想测试 Web 界面，需要先单独启动 API 服务。

## 已知限制

1. **登录状态**：Vercel Functions 无状态，每次请求是新的函数实例。登录 cookie 保存在前端 localStorage 中，换设备需重新登录。
2. **冷启动**：API 函数首次调用时有冷启动延迟（~2-5秒），之后会快很多。
3. **函数超时**：Vercel 函数最长 60 秒，大部分 API 调用没问题。

## 文件说明

| 文件 | 作用 |
|------|------|
| `vercel.json` | Vercel 路由配置（SPA fallback + API functions） |
| `api/index.js` | Serverless Function — NeteaseCloudMusicApi |
| `vite.config.ts` | 更新：输出到 `dist/`，添加开发代理 |
| `.env.vercel` | 环境变量模板 |
| `VERCEL_DEPLOY.md` | 本文档 |
