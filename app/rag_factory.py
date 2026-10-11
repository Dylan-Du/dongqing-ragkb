"""根据 .env 构建 LightRAG 实例：Milvus 向量库 + 在线/本地模型可切换。

环境变量约定与 lightrag-server（WebUI）保持一致，一份 .env 同时驱动：
- scripts/ingest.py   批量入库
- scripts/query.py    命令行问答
- lightrag-server     Web 知识库工作台（读同一份 .env）
"""
import os
from functools import partial
from pathlib import Path

from dotenv import load_dotenv

PROJECT_ROOT = Path(__file__).resolve().parent.parent

# .env 必须在导入 lightrag 之前生效（lightrag 在 import 时就会读取
# SUMMARY_LANGUAGE 等环境变量）
load_dotenv(PROJECT_ROOT / ".env", override=True)


def _resolve(p: str) -> str:
    """把相对路径解析到项目根目录下（保证从任意目录运行都一致）。"""
    path = Path(p).expanduser()
    if not path.is_absolute():
        path = PROJECT_ROOT / path
    return str(path.resolve())


def _abs_milvus_uri(uri: str) -> str:
    """Milvus Lite 的 uri 是本地 .db 文件路径，统一转绝对路径；远程地址原样返回。"""
    if uri and not uri.startswith(("http://", "https://")):
        return _resolve(uri)
    return uri


# pymilvus（2.6+）在 import 时会读取环境变量 MILVUS_URI 并强制校验为 http(s) 形式，
# 且导入时自己 load_dotenv() 重新读 .env —— 所以 .env 里不能把本地文件路径写进
# MILVUS_URI。做法：导入 pymilvus 前保持 MILVUS_URI 干净（文件路径一律转存到
# MILVUS_LITE_PATH），导入完成后再把有效的 Milvus 连接地址放回运行期环境变量，
# 供 LightRAG 的 Milvus 存储在存储初始化时读取。
_raw_uri = os.environ.get("MILVUS_URI", "").strip()
if _raw_uri and not _raw_uri.startswith(("http://", "https://")):
    # 兼容旧写法：用户把 Lite 文件路径填进了 MILVUS_URI
    os.environ["MILVUS_LITE_PATH"] = _raw_uri
    os.environ.pop("MILVUS_URI", None)

import pymilvus  # noqa: E402,F401  必须在环境干净时导入

MILVUS_URI_EFFECTIVE = os.environ.get("MILVUS_URI", "").strip()
if not MILVUS_URI_EFFECTIVE:
    MILVUS_URI_EFFECTIVE = _abs_milvus_uri(
        os.environ.get("MILVUS_LITE_PATH", "./data/milvus_lite.db")
    )
    os.environ["MILVUS_URI"] = MILVUS_URI_EFFECTIVE

# LightRAG 的 Milvus 存储声明了必填项
os.environ.setdefault("MILVUS_DB_NAME", "default")

from lightrag import LightRAG  # noqa: E402
from lightrag.llm.openai import (  # noqa: E402
    openai_complete_if_cache,
    openai_embed,
)
from lightrag.utils import EmbeddingFunc, logger  # noqa: E402


def _masked(key: str | None) -> str:
    if not key:
        return "(未设置)"
    if key in ("ollama", "none"):
        return key
    return key[:6] + "..." + key[-4:] if len(key) > 12 else "***"


def llm_binding_info() -> dict:
    return {
        "binding": os.getenv("LLM_BINDING", "openai"),
        "model": os.getenv("LLM_MODEL", ""),
        "host": os.getenv("LLM_BINDING_HOST", ""),
        "api_key": _masked(os.getenv("LLM_BINDING_API_KEY", "")),
    }


def embedding_binding_info() -> dict:
    return {
        "binding": os.getenv("EMBEDDING_BINDING", "openai"),
        "model": os.getenv("EMBEDDING_MODEL", ""),
        "host": os.getenv("EMBEDDING_BINDING_HOST", ""),
        "dim": os.getenv("EMBEDDING_DIM", ""),
        "api_key": _masked(os.getenv("EMBEDDING_BINDING_API_KEY", "")),
    }


def storage_info() -> dict:
    return {
        "working_dir": _resolve(os.getenv("WORKING_DIR", "./data/rag_storage")),
        "vector_storage": os.getenv("LIGHTRAG_VECTOR_STORAGE", "MilvusVectorDBStorage"),
        "milvus_uri": MILVUS_URI_EFFECTIVE,
    }


def _build_llm() -> tuple[callable, dict]:
    """返回 (llm_model_func, llm_model_kwargs)。"""
    binding = os.getenv("LLM_BINDING", "openai").lower()
    model = os.getenv("LLM_MODEL", "")
    host = os.getenv("LLM_BINDING_HOST", "") or None
    api_key = os.getenv("LLM_BINDING_API_KEY", "") or None

    if binding == "ollama":
        from lightrag.llm.ollama import ollama_model_complete

        kwargs = {
            "host": host or "http://localhost:11434",
            # 实体抽取 prompt 很长，Ollama 默认上下文 2k 会截断，必须调大
            "num_ctx": int(os.getenv("OLLAMA_NUM_CTX", "32768")),
        }
        return ollama_model_complete, kwargs

    # 默认 openai 兼容协议：智谱 GLM / DeepSeek / 通义 Qwen / 硅基流动 / OpenAI
    if not model:
        raise SystemExit("❌ LLM_MODEL 未设置，请检查 .env")
    if not api_key or "在这里填" in api_key:
        raise SystemExit(
            "❌ 模型 API Key 还没配置（还是占位符）。"
            "请打开知识库页面 →「模型接入」→ 选择预设并填入真实 API Key → 保存并生效，"
            "然后重新执行本命令。"
        )

    async def openai_llm(prompt, system_prompt=None, history_messages=None, **kwargs):
        return await openai_complete_if_cache(
            model,
            prompt,
            system_prompt=system_prompt,
            history_messages=history_messages or [],
            base_url=host,
            api_key=api_key,
            **kwargs,
        )

    return openai_llm, {}


def _build_embedding() -> EmbeddingFunc:
    binding = os.getenv("EMBEDDING_BINDING", "openai").lower()
    model = os.getenv("EMBEDDING_MODEL", "")
    dim = int(os.getenv("EMBEDDING_DIM", "1024"))
    host = os.getenv("EMBEDDING_BINDING_HOST", "") or None
    api_key = os.getenv("EMBEDDING_BINDING_API_KEY", "") or None

    if not model:
        raise SystemExit("❌ EMBEDDING_MODEL / EMBEDDING_DIM 未设置，请检查 .env")
    if binding != "ollama" and (not api_key or "在这里填" in api_key):
        raise SystemExit(
            "❌ 向量模型的 API Key 还没配置（还是占位符）。"
            "请打开知识库页面 →「模型接入」→ 填入真实 API Key → 保存并生效。"
        )

    if binding == "ollama":
        from lightrag.llm.ollama import ollama_embed

        # 注意用 .func 取未包装的原函数，避免双层包装（LightRAG 官方要求）
        func = partial(
            ollama_embed.func, embed_model=model, host=host or "http://localhost:11434"
        )
    else:
        func = partial(
            openai_embed, model=model, base_url=host, api_key=api_key
        )

    return EmbeddingFunc(
        embedding_dim=dim,
        max_token_size=int(os.getenv("EMBEDDING_MAX_TOKEN_SIZE", "8192")),
        model_name=model,  # Milvus 集合名会带上模型后缀，实现换模型时的数据隔离
        func=func,
    )


def build_rag() -> LightRAG:
    """按 .env 构建 LightRAG 实例（不初始化存储，需再 await initialize_storages()）。"""
    working_dir = _resolve(os.getenv("WORKING_DIR", "./data/rag_storage"))
    Path(working_dir).mkdir(parents=True, exist_ok=True)

    # Milvus 连接参数由存储实现直接读环境变量（MILVUS_URI/USER/PASSWORD/DB_NAME），
    # 模块顶部已把最终生效的连接地址注入 os.environ["MILVUS_URI"]
    llm_model_func, llm_model_kwargs = _build_llm()

    rag = LightRAG(
        working_dir=working_dir,
        kv_storage="JsonKVStorage",
        vector_storage="MilvusVectorDBStorage",
        graph_storage="NetworkXStorage",
        doc_status_storage="JsonDocStatusStorage",
        # LightRAG 的 Milvus 实现要求显式给出相似度阈值
        vector_db_storage_cls_kwargs={
            "cosine_better_than_threshold": float(
                os.getenv("COSINE_BETTER_THAN_THRESHOLD", "0.2")
            )
        },
        llm_model_func=llm_model_func,
        llm_model_name=os.getenv("LLM_MODEL", ""),
        llm_model_max_async=int(os.getenv("LLM_BINDING_MAX_ASYNC", "4")),
        llm_model_kwargs=llm_model_kwargs,
        embedding_func=_build_embedding(),
        embedding_batch_num=int(os.getenv("EMBEDDING_BATCH_SIZE", "10")),
        embedding_func_max_async=int(os.getenv("EMBEDDING_FUNC_MAX_ASYNC", "4")),
        max_parallel_insert=int(os.getenv("MAX_PARALLEL_INSERT", "2")),
    )
    return rag


async def create_rag() -> LightRAG:
    """构建并完成存储初始化，脚本入口用这个。"""
    rag = build_rag()
    await rag.initialize_storages()
    logger.info("LightRAG 存储初始化完成")
    return rag
