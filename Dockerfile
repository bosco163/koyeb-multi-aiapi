FROM python:3.10-slim as base

# 1. 安装基础依赖
RUN apt-get update && apt-get install -y \
    nginx \
    supervisor \
    git \
    curl \
    gnupg \
    build-essential \
    wget \
    && rm -rf /var/lib/apt/lists/*

# 2. 安装 Node.js 20
RUN mkdir -p /etc/apt/keyrings \
    && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
    && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" | tee /etc/apt/sources.list.d/nodesource.list \
    && apt-get update && apt-get install -y nodejs

# 3. 安装 Go 1.24
RUN curl -fsSL https://go.dev/dl/go1.24.0.linux-amd64.tar.gz | tar -C /usr/local -xz
ENV PATH=$PATH:/usr/local/go/bin
ENV GOPROXY=https://proxy.golang.org,direct

# 4. Edge TTS
WORKDIR /app/tts
RUN git clone https://github.com/travisvn/openai-edge-tts.git . \
    && pip install --no-cache-dir -r requirements.txt

# 5. DS2API
WORKDIR /app/deepseek
RUN git clone https://github.com/CJackHwang/ds2api.git .
WORKDIR /app/deepseek/webui
RUN npm install && npm run build
WORKDIR /app/deepseek
RUN go build -ldflags="-s -w" -o ds2api ./cmd/ds2api \
    && mkdir -p caches data logs static/admin \
    && chmod -R 777 caches data logs

# 6. Qwen2API
WORKDIR /app/qwen
RUN git clone https://github.com/Rfym21/Qwen2API.git . \
    && npm install
WORKDIR /app/qwen/public
RUN npm install && npm run build
WORKDIR /app/qwen
RUN mkdir -p caches data logs && chmod -R 777 caches data logs

FROM base

# 8. 启动脚本
RUN cat > /app/start-ds2api.sh << 'EOF'
#!/bin/bash
cd /app/deepseek
exec ./ds2api
EOF
RUN chmod +x /app/start-ds2api.sh

RUN cat > /app/start-qwen.sh << 'EOF'
#!/bin/bash
unset DS2API_ADMIN_KEY DS2API_JWT_SECRET DS2API_JWT_EXPIRE_HOURS \
    DS2API_CONFIG_PATH DS2API_CONFIG_JSON DS2API_WASM_PATH \
    DS2API_STATIC_ADMIN_DIR DS2API_AUTO_BUILD_WEBUI \
    DS2API_ACCOUNT_MAX_INFLIGHT DS2API_ACCOUNT_CONCURRENCY \
    DS2API_ACCOUNT_MAX_QUEUE DS2API_ACCOUNT_QUEUE_SIZE \
    DS2API_VERCEL_INTERNAL_SECRET DS2API_VERCEL_STREAM_LEASE_TTL_SECONDS \
    VERCEL_TOKEN VERCEL_PROJECT_ID VERCEL_TEAM_ID DS2API_VERCEL_PROTECTION_BYPASS
cd /app/qwen
exec npm start
EOF
RUN chmod +x /app/start-qwen.sh

# 9. 配置 Nginx 和 Supervisor
WORKDIR /app
COPY nginx.conf /etc/nginx/sites-available/default
COPY supervisord.conf /etc/supervisor/conf.d/supervisord.conf

ENV PORT=8080
EXPOSE 8080
CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/conf.d/supervisord.conf"]
