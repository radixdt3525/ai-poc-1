"""Classify SQL statements as read / write / destructive.

This is a UX guard (confirm dialogs, AI tool gate). The hard guarantee for AI-run queries is the
READ ONLY transaction they execute in.
"""

import re
from dataclasses import dataclass

from app.pg.sqltext import mask, split_statements

READ = "read"
WRITE = "write"
DESTRUCTIVE = "destructive"

_WORD_RE = re.compile(r"[A-Z_][A-Z0-9_$]*")
_READ_FIRST = {"SELECT", "WITH", "SHOW", "VALUES", "TABLE", "EXPLAIN"}
_DML = {"INSERT", "UPDATE", "DELETE", "MERGE"}


@dataclass
class Classification:
    kind: str
    reason: str = ""


def _top_level(code: str) -> str:
    """Blank out anything inside parentheses."""
    out, depth = [], 0
    for ch in code:
        if ch == "(":
            depth += 1
            out.append(" ")
        elif ch == ")":
            depth = max(depth - 1, 0)
            out.append(" ")
        else:
            out.append(ch if depth == 0 else " ")
    return "".join(out)


def classify(statement: str) -> Classification:
    code = mask(statement).upper()
    words = _WORD_RE.findall(code)
    top = _WORD_RE.findall(_top_level(code))
    if not words:
        return Classification(READ)
    first = words[0]

    if first in ("DROP", "TRUNCATE"):
        return Classification(DESTRUCTIVE, f"{first} statement")
    if first == "DELETE" and "WHERE" not in top:
        return Classification(DESTRUCTIVE, "DELETE without WHERE clause")
    if first == "UPDATE" and "WHERE" not in top:
        return Classification(DESTRUCTIVE, "UPDATE without WHERE clause")
    if first == "ALTER" and "DROP" in top:
        return Classification(DESTRUCTIVE, "ALTER ... DROP")

    if first == "EXPLAIN":
        analyze = "ANALYZE" in words[:6] or "ANALYSE" in words[:6]
        if analyze and _DML & set(words):
            return Classification(WRITE, "EXPLAIN ANALYZE executes a data-modifying statement")
        return Classification(READ)
    if first == "WITH" and _DML & set(words):
        return Classification(WRITE, "data-modifying CTE")
    if first == "SELECT" and "INTO" in top:
        return Classification(WRITE, "SELECT INTO creates a table")
    if first in _READ_FIRST:
        return Classification(READ)
    return Classification(WRITE, f"{first} statement")


def classify_script(sql: str) -> list[tuple[str, Classification]]:
    return [(stmt, classify(stmt)) for stmt in split_statements(sql)]


def is_read_only(sql: str) -> bool:
    stmts = classify_script(sql)
    return bool(stmts) and all(c.kind == READ for _, c in stmts)
