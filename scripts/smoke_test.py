#!/usr/bin/env python3
"""环境自检（不需要 API Key，不调用任何模型接口）。

检查项:
  1. .env 配置完整性（占位符提醒）
  2. LightRAG 实例构建 + 存储初始化（含 Milvus 连接）
  3. Milvus Lite 读写搜索能力实测（建集合→写入向量→检索→清理）
"""
import asyncio
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))


def banner(text: str) -> None:
    print(f"\n{'=' * 8} {text} {'=' * 8}")


def check_env() -> bool:
    banner("① 配置检查")
    import app.rag_factory as f

    llm, emb, sto = f.llm_binding_info(), f.embedding_binding_info(), f.storage_info()
    print(f"  LLM       : {llm['binding']} / {llm['model']}  @ {llm['host'] or '默认'}  key={llm['api_key']}")
    print(f"  Embedding : {emb['binding']} / {emb['model']}  dim={emb['dim']}  key={emb['api_key']}")
    print(f"  向量库    : {sto['vector_storage']} @ {sto['milvus_uri']}")
    print(f"  工作目录  : {sto['working_dir']}")

    ok = True
    env_file = PROJECT_ROOT / ".env"
    if not env_file.exists():
        print("  ❌ 缺少 .env（cp .env.example .env）")
        return False
    content = env_file.read_text(encoding="utf-8")
    if "在这里填" in content:
        print("  ⚠️  .env 里还有「在这里填」占位符 —— 记得填 API Key（本项测试不联网，可忽略）")
    if not emb["dim"]:
        print("  ⚠️  EMBEDDING_DIM 未设置")
        ok = False
    print("  ✅ 配置文件解析正常")
    return ok


def check_milvus_lite() -> bool:
    banner("② Milvus Lite 读写实测")
    from pymilvus import MilvusClient

    import app.rag_factory as f

    uri = f.storage_info()["milvus_uri"]
    if uri.startswith("http"):
        print(f"  检测到远程 Milvus: {uri}，跳过 Lite 文件库测试")
        return True

    try:
        client = MilvusClient(uri=uri)
        name = "smoke_test_collection"
        if client.has_collection(name):
            client.drop_collection(name)
        client.create_collection(collection_name=name, dimension=8, metric_type="COSINE")
        client.insert(
            collection_name=name,
            data=[
                {"id": 1, "vector": [1.0, 0, 0, 0, 0, 0, 0, 0], "content": "hello"},
                {"id": 2, "vector": [0, 1.0, 0, 0, 0, 0, 0, 0], "content": "world"},
            ],
        )
        hits = client.search(
            collection_name=name,
            data=[[0.9, 0.1, 0, 0, 0, 0, 0, 0]],
            limit=1,
            output_fields=["content"],
        )
        got = hits[0][0]["entity"]["content"]
        client.drop_collection(name)
        print(f"  ✅ 建集合/写入/检索 全部通过（最相似: {got}）")
        return got == "hello"
    except Exception as e:
        print(f"  ❌ Milvus Lite 测试失败: {e}")
        return False


async def check_rag_storages() -> bool:
    banner("③ LightRAG 存储初始化")
    try:
        from app.rag_factory import create_rag

        rag = await create_rag()
        await rag.finalize_storages()
        print("  ✅ LightRAG + Milvus 存储初始化正常")
        return True
    except Exception as e:
        print(f"  ❌ 存储初始化失败: {e}")
        return False


def main() -> int:
    print("RAG 知识库环境自检（不联网、不消耗 Token）")
    results = [check_env(), check_milvus_lite(), asyncio.run(check_rag_storages())]
    banner("结论")
    if all(results):
        print("✅ 全部通过。下一步：")
        print("   1) 在 .env 填好 API Key")
        print("   2) make ingest   # 入库 docs/ 下的文档")
        print("   3) make query Q=\"这个知识库怎么帮我干活？\"")
        print("   4) make server   # 打开 WebUI: http://127.0.0.1:9621")
        return 0
    print("❌ 有未通过项，请按上面的提示修复后重试")
    return 1


if __name__ == "__main__":
    sys.exit(main())
