# syntax=docker/dockerfile:1

# ---------- 依赖与构建 ----------
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM deps AS build
COPY . .
RUN npm run build

# ---------- web：nginx 提供页面与健康响应 ----------
FROM nginx:1.27-alpine AS web
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=5s --timeout=3s --retries=10 --start-period=3s \
  CMD wget -qO- http://127.0.0.1/healthz || exit 1

# ---------- verify：本轮换场景的状态测试 + 静态构建检查 + HTTP 冒烟 ----------
FROM node:20-alpine AS verify
WORKDIR /app
ENV CI=true
# 冒烟目标（Compose 中由 web 服务提供）
ENV WEB_URL=http://web:80
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
# 核心状态测试 → 静态构建检查 → 页面与健康地址 HTTP 冒烟；任一失败即以非零退出码结束
CMD ["sh", "-c", "npm test && npm run build && node scripts/smoke.mjs"]
