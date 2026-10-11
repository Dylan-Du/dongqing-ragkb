#!/usr/bin/env bash
# 一键启动知识库 WebUI（lightrag-server）
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -f .env ]; then
  echo "❌ 未找到 .env，请先执行: cp .env.example .env 并填入 API Key"
  exit 1
fi

if [ ! -x .venv/bin/lightrag-server ]; then
  echo "❌ Web 服务未安装，请先执行: make setup"
  exit 1
fi

echo "🚀 启动知识库 WebUI: http://127.0.0.1:${PORT:-9621} （Ctrl+C 退出）"
exec .venv/bin/python scripts/run_server.py
