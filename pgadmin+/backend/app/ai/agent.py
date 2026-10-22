"""Chat agent: streams an answer, calling read-only DB tools as needed."""

import json
from collections.abc import AsyncIterator

from app.ai.client import get_client
from app.ai.prompts import CHAT_SYSTEM_PROMPT, EDITOR_CONTEXT_TEMPLATE
from app.ai.tools import TOOLS, safe_run_tool
from app.config import settings
from app.pg.introspect import schema_summary


def _preview(result: dict) -> str:
    if "error" in result:
        return f"error: {result['error']}"[:300]
    if "row_count" in result:
        return f"{result['row_count']} row(s){' (truncated)' if result.get('truncated') else ''}"
    if "plan" in result:
        return "plan received"
    if "tables" in result and isinstance(result["tables"], list):
        return f"{len(result['tables'])} table(s)"
    if "columns" in result:
        return f"{len(result['columns'])} column(s), {len(result.get('indexes', []))} index(es)"
    return ", ".join(f"{k}: {len(v)}" for k, v in result.items() if isinstance(v, list)) or "ok"


async def run_chat(
    conn_id: str,
    history: list[dict],
    user_message: str,
    editor_sql: str | None = None,
    editor_error: str | None = None,
) -> AsyncIterator[dict]:
    """Yield events: {type: token|tool_call|tool_result|done|error, ...}."""
    client = get_client()
    summary = await schema_summary(conn_id)
    messages: list[dict] = [
        {"role": "system", "content": CHAT_SYSTEM_PROMPT.replace("{schema_summary}", summary)}
    ]
    messages += history[-20:]
    if editor_sql and editor_sql.strip():
        error_block = f"\nLast error from running it:\n{editor_error}\n" if editor_error else ""
        messages.append(
            {
                "role": "system",
                "content": EDITOR_CONTEXT_TEMPLATE.format(sql=editor_sql.strip()[:8000], error_block=error_block),
            }
        )
    messages.append({"role": "user", "content": user_message})

    content_parts: list[str] = []
    steps: list[dict] = []

    for _ in range(settings.ai_max_steps):
        stream = await client.chat.completions.create(
            model=settings.openai_model, messages=messages, tools=TOOLS, stream=True
        )
        text = ""
        calls: dict[int, dict] = {}
        need_separator = bool(content_parts)  # keep text from earlier rounds visually apart
        async for chunk in stream:
            if not chunk.choices:
                continue
            delta = chunk.choices[0].delta
            if delta.content:
                if need_separator:
                    need_separator = False
                    yield {"type": "token", "content": "\n\n"}
                text += delta.content
                yield {"type": "token", "content": delta.content}
            for tc in delta.tool_calls or []:
                slot = calls.setdefault(tc.index, {"id": "", "name": "", "arguments": ""})
                if tc.id:
                    slot["id"] = tc.id
                if tc.function and tc.function.name:
                    slot["name"] += tc.function.name
                if tc.function and tc.function.arguments:
                    slot["arguments"] += tc.function.arguments
        if text:
            content_parts.append(text)

        if not calls:
            break

        ordered = [calls[i] for i in sorted(calls)]
        messages.append(
            {
                "role": "assistant",
                "content": text or None,
                "tool_calls": [
                    {"id": c["id"], "type": "function", "function": {"name": c["name"], "arguments": c["arguments"]}}
                    for c in ordered
                ],
            }
        )
        for call in ordered:
            try:
                args = json.loads(call["arguments"] or "{}")
            except json.JSONDecodeError:
                args = {"raw": call["arguments"]}
            yield {"type": "tool_call", "id": call["id"], "name": call["name"], "args": args}
            result = await safe_run_tool(conn_id, call["name"], call["arguments"])
            preview = _preview(result)
            steps.append({"name": call["name"], "args": args, "preview": preview, "ok": "error" not in result})
            yield {"type": "tool_result", "id": call["id"], "name": call["name"], "preview": preview,
                   "ok": "error" not in result}
            messages.append(
                {"role": "tool", "tool_call_id": call["id"], "content": json.dumps(result, default=str)[:20000]}
            )
    else:
        msg = "\n\n_(Stopped after reaching the maximum number of tool steps.)_"
        content_parts.append(msg)
        yield {"type": "token", "content": msg}

    yield {"type": "done", "content": "\n\n".join(content_parts), "steps": steps}
