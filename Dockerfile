FROM python:3.10-slim

# 1. 安装基础工具
RUN apt-get update && apt-get install -y \
    nginx \
    supervisor \
    git \
    curl \
    gnupg \
    build-essential \
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

# 4. 部署 DeepSeek2API
WORKDIR /app/deepseek
RUN git clone https://github.com/iidamie/deepseek2api.git .
RUN pip install --no-cache-dir -r requirements.txt

# 5. 部署 Qwen2API
WORKDIR /app/qwen
RUN git clone https://github.com/Rfym21/Qwen2API.git .
RUN npm install
WORKDIR /app/qwen/public
RUN npm install
RUN npm run build
WORKDIR /app/qwen
RUN mkdir -p caches data logs && chmod -R 777 caches data logs

# =========================================================
# 6. 部署 Gemini 逆向 - 修复 Base URL 显示问题
# =========================================================
WORKDIR /app/gemini
RUN git clone https://github.com/erxiansheng/gemininixiang.git .
RUN pip install --no-cache-dir -r requirements.txt

# ⚠️ 强力修复版
# 1. 强制替换 "Base URL: [任何变量] v1" 这一整段逻辑
# 2. 额外替换 request.host_url，防止其他地方也用错
# 3. 写入账号密码
RUN sed -i 's|Base URL: .*v1|Base URL: https://lhy-db-tts.koyeb.app/v1|g' server.py && \
    sed -i 's|request.host_url|"https://lhy-db-tts.koyeb.app/"|g' server.py && \
    sed -i 's/ADMIN_USERNAME = .*/ADMIN_USERNAME = "admin"/' server.py && \
    sed -i 's/ADMIN_PASSWORD = .*/ADMIN_PASSWORD = "1"/' server.py && \
    sed -i 's/API_KEY = .*/API_KEY = "1"/' server.py

# 8. 配置 Nginx 和 Supervisor
WORKDIR /app
COPY nginx.conf /etc/nginx/sites-available/default
COPY supervisord.conf /etc/supervisor/conf.d/supervisord.conf

ENV PORT=8080
EXPOSE 8080

CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/conf.d/supervisord.conf"]
