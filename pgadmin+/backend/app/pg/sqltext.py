"""Lexical helpers for PostgreSQL text: statement splitting and masking of literals/comments.

Handles '...' (incl. E'' escapes), "identifiers", $tag$ dollar quotes $tag$, -- and nested /* */ comments.
"""

import re

_DOLLAR_RE = re.compile(r"\$([A-Za-z_][A-Za-z0-9_]*)?\$")


def _is_word_char(ch: str) -> bool:
    return ch.isalnum() or ch == "_"


def regions(sql: str) -> list[tuple[int, int, str]]:
    """Return (start, end, kind) spans of strings, quoted identifiers and comments."""
    out: list[tuple[int, int, str]] = []
    i, n = 0, len(sql)
    while i < n:
        c = sql[i]
        if c == "-" and sql.startswith("--", i):
            j = sql.find("\n", i)
            j = n if j == -1 else j
            out.append((i, j, "comment"))
            i = j
            continue
        if c == "/" and sql.startswith("/*", i):
            depth, j = 1, i + 2
            while j < n and depth:
                if sql.startswith("/*", j):
                    depth, j = depth + 1, j + 2
                elif sql.startswith("*/", j):
                    depth, j = depth - 1, j + 2
                else:
                    j += 1
            out.append((i, j, "comment"))
            i = j
            continue
        if c == "'":
            escape = i > 0 and sql[i - 1] in "eE" and (i < 2 or not _is_word_char(sql[i - 2]))
            j = i + 1
            while j < n:
                if escape and sql[j] == "\\":
                    j += 2
                    continue
                if sql[j] == "'":
                    if j + 1 < n and sql[j + 1] == "'":
                        j += 2
                        continue
                    break
                j += 1
            j = min(j + 1, n)
            out.append((i, j, "string"))
            i = j
            continue
        if c == '"':
            j = i + 1
            while j < n:
                if sql[j] == '"':
                    if j + 1 < n and sql[j + 1] == '"':
                        j += 2
                        continue
                    break
                j += 1
            j = min(j + 1, n)
            out.append((i, j, "ident"))
            i = j
            continue
        if c == "$" and not (i > 0 and _is_word_char(sql[i - 1])):
            m = _DOLLAR_RE.match(sql, i)
            if m:
                tag = m.group(0)
                end = sql.find(tag, m.end())
                j = n if end == -1 else end + len(tag)
                out.append((i, j, "string"))
                i = j
                continue
        i += 1
    return out


def mask(sql: str) -> str:
    """Replace strings, quoted identifiers and comments with spaces (length preserved)."""
    chars = list(sql)
    for start, end, _ in regions(sql):
        for k in range(start, end):
            if chars[k] != "\n":
                chars[k] = " "
    return "".join(chars)


def split_statements(sql: str) -> list[str]:
    """Split a script on top-level semicolons; drops empty / comment-only statements."""
    masked = mask(sql)
    out: list[str] = []
    start = 0
    for idx, ch in enumerate(masked):
        if ch == ";":
            if masked[start:idx].strip():
                out.append(sql[start:idx].strip())
            start = idx + 1
    if masked[start:].strip():
        out.append(sql[start:].strip())
    return out
