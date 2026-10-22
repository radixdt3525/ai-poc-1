from openai import AsyncOpenAI

from app.config import settings


class AIUnavailable(Exception):
    pass


_client: AsyncOpenAI | None = None


def get_client() -> AsyncOpenAI:
    global _client
    if not settings.ai_enabled:
        raise AIUnavailable("OPENAI_API_KEY is not configured")
    if _client is None:
        _client = AsyncOpenAI(api_key=settings.openai_api_key, base_url=settings.openai_base_url or None)
    return _client
