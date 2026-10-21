# ---------- 构建阶段 ----------
FROM node:22-alpine AS deps

WORKDIR /app

# 优先用 lock 文件做可复现安装；没有 lock 时退回 install
COPY package*.json ./
RUN if [ -f package-lock.json ]; then \
      npm ci --omit=dev; \
    else \
      npm install --omit=dev; \
    fi

# ---------- 运行阶段 ----------
FROM node:22-alpine

# 使用非 root 用户运行，降低容器逃逸风险
WORKDIR /app

ENV NODE_ENV=production \
    PORT=8899 \
    HOST=0.0.0.0 \
    KB_DIR=knowledge \
    DATA_DIR=data

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
COPY scripts ./scripts
COPY public ./public
COPY knowledge ./knowledge

# 数据目录留作挂载点：索引与用户上传的资料都写在这里
RUN mkdir -p /app/data && chown -R node:node /app

USER node

EXPOSE 8899

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8899)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
