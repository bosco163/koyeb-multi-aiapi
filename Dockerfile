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

# 3. 部署 Edge TTS (Python - 5050)
WORKDIR /app/tts
RUN git clone https://github.com/travisvn/openai-edge-tts.git .
RUN pip install --no-cache-dir -r requirements.txt

# 4. 部署 DeepSeek2API (Python - 5001)
WORKDIR /app/deepseek
RUN git clone https://github.com/iidamie/deepseek2api.git .
RUN pip install --no-cache-dir -r requirements.txt

# 5. 部署 Qwen2API (Node - 3000)
WORKDIR /app/qwen
RUN git clone https://github.com/Rfym21/Qwen2API.git .
RUN npm install
# 编译前端
WORKDIR /app/qwen/public
RUN npm install
RUN npm run build
# 权限处理
WORKDIR /app/qwen
RUN mkdir -p caches data logs && chmod -R 777 caches data logs

# 6. 部署 Gemini 逆向 (Python - 8000) [原 Doubao 已替换]
WORKDIR /app/gemini
RUN git clone https://github.com/erxiansheng/gemininixiang.git .
RUN pip install --no-cache-dir -r requirements.txt
# 直接修改代码中的配置
RUN sed -i 's/ADMIN_USERNAME = .*/ADMIN_USERNAME = "admin"/' server.py && \
    sed -i 's/ADMIN_PASSWORD = .*/ADMIN_PASSWORD = "1"/' server.py && \
    sed -i 's/API_KEY = .*/API_KEY = "1"/' server.py

# 8. 配置 Nginx 和 Supervisor
WORKDIR /app
COPY nginx.conf /etc/nginx/sites-available/default
COPY supervisord.conf /etc/supervisor/conf.d/supervisord.conf

# ⚠️ 关键修改：告诉 Koyeb 现在入口是 8080
ENV PORT=8080
EXPOSE 8080

CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/conf.d/supervisord.conf"]
