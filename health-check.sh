#!/bin/bash

echo "=== 开始健康检查 ==="
date

# 检查 Nginx 是否在运行
if ! curl -f http://localhost:8080/healthz > /dev/null 2>&1; then
    echo "❌ Nginx 健康检查失败"
    exit 1
fi
echo "✅ Nginx 健康检查通过"

# 检查各个后端服务
services=("5050" "3000" "8000" "8001")
service_names=("Edge TTS" "Qwen2API" "DeepSeek API" "QwenChat2Api")

for i in "${!services[@]}"; do
    port=${services[$i]}
    name=${service_names[$i]}
    
    # 尝试连接到服务
    if timeout 5 bash -c "echo > /dev/tcp/127.0.0.1/$port" 2>/dev/null; then
        echo "✅ $name (端口 $port) 正在运行"
    else
        echo "⚠️  $name (端口 $port) 可能未运行"
    fi
done

echo "=== 健康检查完成 ==="

# 如果 Nginx 健康检查通过，容器就是健康的
exit 0
