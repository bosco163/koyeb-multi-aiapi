FROM python:3.10-slim

# 1. 安装基础工具
RUN apt-get update && apt-get install -y \
    nginx \
    supervisor \
    git \
    curl \
    gnupg \
    build-essential \
    net-tools \
    iputils-ping \
    && rm -rf /var/lib/apt/lists/*

# 2. 安装 Node.js 20
RUN mkdir -p /etc/apt/keyrings
RUN curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
RUN echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" | tee /etc/apt/sources.list.d/nodesource.list
RUN apt-get update && apt-get install -y nodejs

# 3. 部署 Edge TTS
WORKDIR /app/tts
RUN git clone https://github.com/travisvn/openai-edge-tts.git .
RUN pip install --no-cache-dir -r requirements.txt

# 4. 部署 DeepSeek Free API
WORKDIR /app/deepseek
RUN git clone https://github.com/Fu-Jie/deepseek-free-api.git .
RUN npm install
RUN npm run build

# 5. 部署 Qwen2API (根目录服务)
WORKDIR /app/qwen
RUN git clone https://github.com/Rfym21/Qwen2API.git .
RUN npm install
WORKDIR /app/qwen/public
RUN npm install
RUN npm run build
WORKDIR /app/qwen
RUN mkdir -p caches data logs && chmod -R 777 caches data logs

# =========================================================
# 6. 部署 QwenChat2Api (新项目: /qw)
# =========================================================
WORKDIR /app/qw
RUN git clone https://github.com/ckcoding/qwenchat2api.git .
RUN npm install
RUN npm audit fix || true

# 7. 配置 Nginx 和 Supervisor
WORKDIR /app
COPY nginx.conf /etc/nginx/sites-available/default
COPY supervisord.conf /etc/supervisor/conf.d/supervisord.conf
COPY start.sh /app/start.sh
RUN chmod +x /app/start.sh

# 测试 Nginx 配置
RUN nginx -t

ENV PORT=8080
EXPOSE 8080

# 使用启动脚本
CMD ["/app/start.sh"]
