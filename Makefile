# RAG 知识库常用命令（make 无参数可看全部目标）
PY := .venv/bin/python
LU := gui/$(shell id -u)

.PHONY: help setup smoke ingest query chat server server-start server-stop server-restart server-log milvus-up milvus-down clean

help:
	@echo "RAG 知识库命令:"
	@echo "  make setup                       安装依赖（首次）"
	@echo "  make smoke                       环境自检（不消耗Token）"
	@echo "  make ingest                      入库 docs/ 目录全部文档"
	@echo "  make ingest DIRS='docs 报告'      入库指定目录/文件"
	@echo "  make query Q='问题'               单次提问"
	@echo "  make chat                        多轮对话模式"
	@echo "  make server                      重启 Web 服务（系统服务，开机自启）"
	@echo "  make server-stop / server-start  停止 / 启动服务"
	@echo "  make server-log                  看服务日志"
	@echo "  make milvus-up / milvus-down     启动/停止 Docker 版 Milvus"
	@echo "  make clean                       清空知识库数据"

setup:
	uv venv --python 3.12 .venv || true
	uv pip install -r requirements.txt --python .venv/bin/python
	@echo "✅ 依赖就绪，接下来: cp .env.example .env 填 Key，然后 make smoke"

smoke:
	$(PY) scripts/smoke_test.py

ingest:
	@# Milvus Lite 是单进程锁：先停 Web 服务，入库完自动拉起
	launchctl bootout $(LU)/com.ragkb.server 2>/dev/null || true
	@sleep 2
	$(PY) scripts/ingest.py $(DIRS); status=$$?; \
	launchctl bootstrap $(LU) ~/Library/LaunchAgents/com.ragkb.server.plist 2>/dev/null || true; \
	exit $$status

query:
	@if [ -z "$(Q)" ]; then echo "用法: make query Q='你的问题'"; else $(PY) scripts/query.py "$(Q)"; fi

chat:
	$(PY) scripts/query.py --chat

server:
	launchctl kickstart -k $(LU)/com.ragkb.server
	@echo "✅ 服务已重启: http://127.0.0.1:9621 （改过 .env 后用它生效）"

server-start:
	launchctl bootstrap $(LU) ~/Library/LaunchAgents/com.ragkb.server.plist 2>/dev/null || \
	launchctl kickstart -k $(LU)/com.ragkb.server
	@echo "✅ 服务已启动: http://127.0.0.1:9621"

server-stop:
	launchctl bootout $(LU)/com.ragkb.server 2>/dev/null || true
	@echo "🛑 服务已停止"

server-log:
	tail -f ~/.ragkb/server.log

milvus-up:
	docker compose -f docker-compose.milvus.yml up -d
	@echo "✅ Milvus 已启动 (localhost:19530)，在 .env 打开「方式B」注释并注释掉 MILVUS_URI 文件路径"

milvus-down:
	docker compose -f docker-compose.milvus.yml down

clean:
	$(PY) scripts/ingest.py --clean
