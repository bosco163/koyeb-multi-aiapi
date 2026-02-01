#!/bin/bash

echo "=== 检查端口占用情况 ==="
echo "检查 3000 端口:"
lsof -i:3000 || echo "3000 端口空闲"
echo ""

echo "检查 5001 端口:"
lsof -i:5001 || echo "5001 端口空闲"
echo ""

echo "检查 5050 端口:"
lsof -i:5050 || echo "5050 端口空闲"
echo ""

echo "检查 8000 端口:"
lsof -i:8000 || echo "8000 端口空闲"
echo ""

echo "检查 8080 端口:"
lsof -i:8080 || echo "8080 端口空闲"
echo "=== 端口检查完成 ==="
