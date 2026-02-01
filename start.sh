#!/bin/bash

echo "🚀 启动所有 AI 服务..."
echo "当前时间: $(date)"

# 先启动 Nginx，让 Koyeb 健康检查能够立即响应
echo "📦 启动 Nginx..."
nginx -c /etc/nginx/nginx.conf

# 等待 Nginx 启动
sleep 2

# 检查 Nginx 是否启动
if ! curl -f http://localhost:8080/healthz > /dev/null 2>&1; then
    echo "❌ Nginx 启动失败"
    exit 1
fi
echo "✅ Nginx 启动成功"

# 启动 Supervisor 管理其他服务
echo "📦 启动 Supervisor..."
/usr/bin/supervisord -c /etc/supervisor/conf.d/supervisord.conf

# 等待所有服务启动
echo "⏳ 等待服务启动..."
sleep 10

# 检查所有服务状态
echo "🔍 检查服务状态..."
services=("nginx" "edge-tts" "deepseek" "qw" "qwen")
for service in "${services[@]}"; do
    if supervisorctl status $service | grep -q RUNNING; then
        echo "✅ $service 正在运行"
    else
        echo "⚠️  $service 状态异常"
        supervisorctl status $service
    fi
done

echo "🎉 所有服务启动完成!"
echo "================================="
echo "服务访问地址:"
echo "- 主页: http://localhost:8080/"
echo "- DeepSeek API: http://localhost:8080/ds/"
echo "- QwenChat2Api: http://localhost:8080/qw/"
echo "- Qwen2API: http://localhost:8080/api/"
echo "- Edge TTS: http://localhost:8080/v1/audio"
echo "- 健康检查: http://localhost:8080/healthz"
echo "================================="

# 保持容器运行
echo "🔄 进入运行状态..."
tail -f /var/log/supervisor/supervisord.log
