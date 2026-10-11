#!/usr/bin/env python3
"""向知识库提问（命令行问答 / 交互聊天）。

用法:
  python scripts/query.py "这个知识库怎么帮我干活？"          # 单次提问（mix 模式）
  python scripts/query.py "..." --mode local --stream        # 指定检索模式 + 流式输出
  python scripts/query.py --chat                             # 多轮对话模式
  python scripts/query.py "..." --context                    # 只看检索到的资料，不生成回答

检索模式:
  mix     知识图谱 + 向量混合检索（默认，综合效果最好）
  hybrid  局部+全局图谱检索
  local   侧重具体实体细节
  global  侧重主题全局概况
  naive   纯向量检索，不走图谱
  bypass  不检索，直接让大模型回答（对照用）
"""
import argparse
import asyncio
import json
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from lightrag import QueryParam  # noqa: E402

from app.rag_factory import create_rag  # noqa: E402

MODES = ["mix", "hybrid", "local", "global", "naive", "bypass"]


def make_param(args) -> QueryParam:
    return QueryParam(
        mode=args.mode,
        only_need_context=args.context,
        stream=args.stream and not args.context,
        top_k=args.top_k,
        user_prompt=args.prompt,
        conversation_history=getattr(args, "_history", []),
    )


async def ask(rag, question: str, args) -> str:
    """执行一次查询并打印，返回完整回答文本（供多轮对话记录历史）。"""
    param = make_param(args)
    if args.stream and not args.context:
        chunks: list[str] = []
        resp = await rag.aquery(question, param=param)
        async for chunk in resp:
            chunks.append(chunk)
            print(chunk, end="", flush=True)
        print()
        return "".join(chunks)

    resp = await rag.aquery(question, param=param)
    if isinstance(resp, str):
        print(resp)
        return resp
    print(json.dumps(resp, ensure_ascii=False, indent=2))
    return json.dumps(resp, ensure_ascii=False)


async def cmd_chat(args) -> None:
    args._history = []
    rag = await create_rag()
    print("💬 交互模式（多轮对话），输入 q / exit 退出，-- 清空历史\n")
    while True:
        try:
            question = input("你 > ").strip()
        except (EOFError, KeyboardInterrupt):
            break
        if not question:
            continue
        if question.lower() in ("q", "exit", "quit"):
            break
        if question == "--":
            args._history.clear()
            print("（历史已清空）\n")
            continue
        try:
            print("知识库 > ", end="", flush=True)
            answer = await ask(rag, question, args)
        except Exception as e:
            print(f"\n❌ 查询出错: {e}")
            answer = ""
        print()
        args._history.append({"role": "user", "content": question})
        if answer:
            args._history.append({"role": "assistant", "content": answer})
    await rag.finalize_storages()


async def cmd_once(args) -> None:
    rag = await create_rag()
    await ask(rag, args.question, args)
    await rag.finalize_storages()


def main() -> None:
    parser = argparse.ArgumentParser(description="RAG 知识库问答")
    parser.add_argument("question", nargs="?", help="问题")
    parser.add_argument("--chat", action="store_true", help="多轮对话模式")
    parser.add_argument("--mode", choices=MODES, default="mix", help="检索模式（默认 mix）")
    parser.add_argument("--stream", action="store_true", help="流式输出")
    parser.add_argument("--context", action="store_true", help="只返回检索资料，不生成回答")
    parser.add_argument("--top-k", type=int, default=None, help="检索条数")
    parser.add_argument("--prompt", default=None, help="附加回答要求，如 --prompt '用要点列出'")
    args = parser.parse_args()

    if args.chat:
        asyncio.run(cmd_chat(args))
    elif args.question:
        asyncio.run(cmd_once(args))
    else:
        parser.print_help()
        print("\n示例: python scripts/query.py \"这个知识库怎么帮我干活？\" --stream")


if __name__ == "__main__":
    main()
