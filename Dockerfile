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

# 2. 安装 Node.js 20 (保留，给 Qwen 用)
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
# 6. 部署 Gemini 逆向 - 更新为 chyinan 版本
# =========================================================
WORKDIR /app/gemini

# 拉取新项目源码
RUN git clone https://github.com/chyinan/gemininixiang.git .

# 安装依赖
RUN pip install --no-cache-dir -r requirements.txt

# 配置修改 (适配现有环境)
# 1. 修改端口为 8000 (这样 nginx.conf 就不需要改了，默认配置是 / -> 8000)
# 2. 修改后台密码为 "1" (保持之前的习惯)
# 3. 修改 API Key 为 "1"
# 4. 替换 Base URL 显示文本 (可选，为了保持界面显示的一致性)
RUN sed -i 's/PORT = [0-9]*/PORT = 8000/' server.py && \
    sed -i 's/ADMIN_PASSWORD = .*/ADMIN_PASSWORD = "1"/' server.py && \
    sed -i 's/API_KEY = .*/API_KEY = "1"/' server.py && \
    sed -i 's|Base URL: .*v1|Base URL: https://lhy-db-tts.koyeb.app/v1|g' server.py

# 8. 配置 Nginx 和 Supervisor
WORKDIR /app
COPY nginx.conf /etc/nginx/sites-available/default
COPY supervisord.conf /etc/supervisor/conf.d/supervisord.conf

ENV PORT=8080
EXPOSE 8080

CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/conf.d/supervisord.conf"]
