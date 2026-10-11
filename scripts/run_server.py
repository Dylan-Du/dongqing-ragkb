#!/usr/bin/env python3
"""启动知识库 Web 服务。

- 挂载自研中文工作台到根路径（/ 与 /aiui），原生英文 WebUI 保留在 /webui
- 之所以包装：pymilvus 在 import 时会校验环境变量 MILVUS_URI 必须是 http(s)，
  而 Milvus Lite 需要 .db 文件路径。这里先借 app.rag_factory 完成环境准备
  （pymilvus 导入放行 + 把生效的 Milvus 连接地址注入运行期环境），再拉起服务。
"""
import os
import sys
import threading
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

import app.rag_factory  # noqa: F401,E402  导入即完成环境准备（pymilvus/MILVUS_URI 适配）


def main() -> None:
    if sys.platform == "win32":
        import asyncio

        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

    from lightrag.api.config import global_args, initialize_config
    from lightrag.api.lightrag_server import (
        check_and_install_dependencies,
        check_env_file,
        configure_logging,
        create_app,
        display_splash_screen,
        update_uvicorn_mode_config,
    )
    import uvicorn
    from fastapi.responses import RedirectResponse
    from fastapi.staticfiles import StaticFiles

    initialize_config()

    if not check_env_file():
        sys.exit(1)
    check_and_install_dependencies()
    configure_logging()
    update_uvicorn_mode_config()
    display_splash_screen(global_args)

    app = create_app(global_args)

    # ── 模型配置热更新：UI 填 URL+密钥 → 写 .env → 自动重启生效 ──
    import json as _json

    from fastapi import Request
    from fastapi.responses import JSONResponse

    MODEL_KEYS = [
        "LLM_BINDING", "LLM_MODEL", "LLM_BINDING_HOST", "LLM_BINDING_API_KEY",
        "EMBEDDING_BINDING", "EMBEDDING_MODEL", "EMBEDDING_BINDING_HOST",
        "EMBEDDING_BINDING_API_KEY", "EMBEDDING_DIM",
    ]

    def _write_env_updates(updates: dict) -> None:
        env_path = (PROJECT_ROOT / ".env").resolve()
        lines = (
            env_path.read_text(encoding="utf-8").splitlines()
            if env_path.exists()
            else []
        )
        for key, val in updates.items():
            replaced = False
            for i, line in enumerate(lines):
                if line.startswith(f"{key}=") and not line.lstrip().startswith("#"):
                    lines[i] = f"{key}={val}"
                    replaced = True
                    break
            if not replaced:
                lines.append(f"{key}={val}")
        env_path.write_text("\n".join(lines) + "\n", encoding="utf-8")

    @app.post("/aiui/model-config", include_in_schema=False)
    async def set_model_config(request: Request):
        expected = os.getenv("LIGHTRAG_API_KEY", "")
        if expected and request.headers.get("authorization", "") != f"Bearer {expected}":
            return JSONResponse({"detail": "需要鉴权"}, status_code=401)
        try:
            body = _json.loads(await request.body() or b"{}")
        except Exception:
            return JSONResponse({"detail": "请求体必须是 JSON"}, status_code=400)
        llm = body.get("llm") or {}
        emb = body.get("embedding") or {}
        if not (llm.get("model") or "").strip() or not (emb.get("model") or "").strip():
            return JSONResponse(
                {"detail": "请填写对话模型与向量模型的名称"}, status_code=400
            )
        try:
            dim = int(emb.get("dim") or 0)
        except ValueError:
            return JSONResponse({"detail": "向量维度必须是数字"}, status_code=400)
        if dim <= 0:
            dim = 1024 if emb.get("binding") == "ollama" else 1536

        updates = {
            "LLM_BINDING": "ollama" if llm.get("binding") == "ollama" else "openai",
            "LLM_MODEL": llm["model"].strip(),
            "LLM_BINDING_HOST": (llm.get("host") or "").strip(),
            "EMBEDDING_BINDING": "ollama" if emb.get("binding") == "ollama" else "openai",
            "EMBEDDING_MODEL": emb["model"].strip(),
            "EMBEDDING_BINDING_HOST": (emb.get("host") or "").strip(),
            "EMBEDDING_DIM": str(dim),
        }
        # 密钥留空 = 保留服务端现有密钥；但若现有密钥是占位符则必须填
        if (llm.get("api_key") or "").strip():
            updates["LLM_BINDING_API_KEY"] = llm["api_key"].strip()
        if (emb.get("api_key") or "").strip():
            updates["EMBEDDING_BINDING_API_KEY"] = emb["api_key"].strip()
        if "EMBEDDING_BINDING_API_KEY" not in updates and not _key_ok(
            "EMBEDDING_BINDING_API_KEY"
        ):
            return JSONResponse(
                {
                    "detail": "向量模型密钥未配置：对话中转站一般不含向量模型，"
                    "请注册 open.bigmodel.cn（智谱，embedding-3）或 siliconflow.cn"
                    "（bge-m3 免费）拿 Key，填到「向量模型」的密钥框里。"
                },
                status_code=400,
            )

        _write_env_updates(updates)
        # 原地重启进程（LaunchAgent KeepAlive 兜底），0.6s 后生效
        threading.Timer(
            0.6, lambda: os.execv(sys.executable, [sys.executable, *sys.argv])
        ).start()
        return {"status": "restarting", "model": updates["LLM_MODEL"]}

    # ── 模型配置状态：向前端暴露密钥是否已真实配置 ──
    def _key_ok(name: str) -> bool:
        v = (os.getenv(name) or "").strip()
        return bool(v) and "在这里填" not in v

    @app.get("/aiui/model-status", include_in_schema=False)
    async def model_status():
        return {
            "llm_key_ok": _key_ok("LLM_BINDING_API_KEY"),
            "emb_key_ok": _key_ok("EMBEDDING_BINDING_API_KEY"),
        }

    # ── 模型连通性测试：UI 点一下就知道 URL/密钥/模型名对不对 ──
    @app.post("/aiui/test-model", include_in_schema=False)
    async def test_model_config(request: Request):
        expected = os.getenv("LIGHTRAG_API_KEY", "")
        if expected and request.headers.get("authorization", "") != f"Bearer {expected}":
            return JSONResponse({"detail": "需要鉴权"}, status_code=401)
        try:
            body = _json.loads(await request.body() or b"{}")
        except Exception:
            return JSONResponse({"detail": "请求体必须是 JSON"}, status_code=400)
        kind = body.get("type", "llm")
        binding = body.get("binding", "openai")
        host = (body.get("host") or "").strip().rstrip("/")
        model = (body.get("model") or "").strip()
        api_key = (body.get("api_key") or "").strip()

        if binding == "ollama":
            host = (host or "http://localhost:11434").rstrip("/")
            api_key = api_key or "ollama"
        else:
            # 容错：用户常把完整端点贴进来，剥掉尾段还原成 base url
            for suffix in ("/chat/completions", "/embeddings"):
                if host.endswith(suffix):
                    host = host[: -len(suffix)]
        if not host:
            return {"ok": False, "error": "请填写接口地址 URL"}
        if not model:
            return {"ok": False, "error": "请填写模型名称"}
        if api_key and "在这里填" in api_key:
            return {"ok": False, "error": "密钥还是占位符，请填入真实 API Key"}
        # 密钥留空 = 用服务端已配置的密钥测试（与保存语义一致）
        if not api_key and binding != "ollama":
            api_key = (
                os.getenv("LLM_BINDING_API_KEY" if kind == "llm" else "EMBEDDING_BINDING_API_KEY")
                or ""
            ).strip()
        if binding != "ollama" and (not api_key or "在这里填" in api_key):
            return {"ok": False, "error": "尚未配置密钥：请先填入真实 API Key"}

        if kind == "emb" and binding == "ollama":
            url, payload = f"{host}/api/embed", {"model": model, "input": "测试"}
        elif kind == "emb":
            url, payload = f"{host}/embeddings", {"model": model, "input": "测试"}
        elif binding == "ollama":
            url = f"{host}/api/chat"
            payload = {"model": model, "messages": [{"role": "user", "content": "回复OK"}],
                       "stream": False, "options": {"num_predict": 16}}
        else:
            url = f"{host}/chat/completions"
            payload = {"model": model, "messages": [{"role": "user", "content": "回复OK"}],
                       "max_tokens": 16}

        headers = {"Content-Type": "application/json"}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        try:
            import httpx

            async with httpx.AsyncClient(timeout=40) as client:
                resp = await client.post(url, json=payload, headers=headers)
        except Exception as e:
            return {"ok": False, "error": f"请求失败：{e}"}
        try:
            data = resp.json()
        except Exception:
            return {"ok": False, "error": f"HTTP {resp.status_code}，响应不是 JSON：{resp.text[:120]}"}
        if resp.status_code != 200:
            err = data.get("error") if isinstance(data, dict) else None
            msg = (err.get("message") if isinstance(err, dict) else str(err)) or resp.text[:160]
            return {"ok": False, "error": f"HTTP {resp.status_code}：{msg}"}
        try:
            if kind == "llm":
                if binding == "ollama":
                    content = (data.get("message") or {}).get("content", "")
                else:
                    content = (data["choices"][0]["message"] or {}).get("content", "")
                return {"ok": True, "reply": (content or "(空回复，模型可用)")[:40]}
            if binding == "ollama":
                dim = len(data["embeddings"][0])
            else:
                dim = len(data["data"][0]["embedding"])
            return {"ok": True, "dim": dim}
        except Exception:
            return {"ok": False, "error": f"响应格式不符合 {kind.upper()} 接口规范：{str(data)[:140]}"}

    # ── 挂载中文工作台：/aiui + 根路径重定向 ──
    ui_dir = PROJECT_ROOT / "app" / "webui_cn"
    if ui_dir.is_dir():
        # 静态资源禁用启发式缓存（保留 ETag 协商，改动即时生效）
        @app.middleware("http")
        async def no_cache_static(request, call_next):
            response = await call_next(request)
            if request.url.path.startswith("/aiui"):
                response.headers["Cache-Control"] = "no-cache"
            return response

        app.mount("/aiui", StaticFiles(directory=str(ui_dir), html=True), name="aiui")
        # 移除 create_app 注册的「/ → /webui」重定向，改为指向中文工作台
        app.router.routes[:] = [
            r
            for r in app.router.routes
            if not (
                getattr(r, "path", None) == "/"
                and getattr(getattr(r, "endpoint", None), "__name__", "") == "redirect_to_webui"
            )
        ]

        @app.get("/", include_in_schema=False)
        async def root_redirect() -> RedirectResponse:
            return RedirectResponse(url="/aiui/", status_code=307)

        print(f"✅ 中文工作台已挂载: http://{global_args.host}:{global_args.port}/aiui/")
    else:
        print(f"⚠️ 未找到中文工作台目录 {ui_dir}，仅提供原生 WebUI")

    uvicorn.run(app=app, host=global_args.host, port=global_args.port, log_config=None)


if __name__ == "__main__":
    main()
