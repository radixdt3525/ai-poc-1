import datetime as dt
import math
from decimal import Decimal

import asyncpg

_MAX_SAFE_INT = 2**53 - 1


def to_json(value):
    """Convert asyncpg result values into JSON-safe values without losing precision."""
    if value is None or isinstance(value, (bool, str)):
        return value
    if isinstance(value, int):
        return value if abs(value) <= _MAX_SAFE_INT else str(value)
    if isinstance(value, float):
        return value if math.isfinite(value) else str(value)
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, (dt.datetime, dt.date, dt.time)):
        return value.isoformat()
    if isinstance(value, dt.timedelta):
        return str(value)
    if isinstance(value, (bytes, bytearray, memoryview)):
        raw = bytes(value)
        text = "\\x" + raw[:1024].hex()
        return text + ("..." if len(raw) > 1024 else "")
    if isinstance(value, asyncpg.Record):
        return {k: to_json(v) for k, v in value.items()}
    if isinstance(value, dict):
        return {str(k): to_json(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [to_json(v) for v in value]
    return str(value)


def record_to_dict(record: asyncpg.Record) -> dict:
    return {k: to_json(v) for k, v in record.items()}
