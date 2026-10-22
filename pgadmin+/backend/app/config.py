from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    openai_api_key: str = ""
    openai_model: str = "gpt-4.1"
    openai_base_url: str | None = None

    meta_database_url: str = "postgresql+asyncpg://pgplus:pgplus@meta-db:5432/pgplus"
    # Any string; hashed into a Fernet key. If empty, a key is generated and kept in the meta DB.
    app_secret_key: str = ""

    insights_interval_minutes: int = 30
    query_row_limit: int = 1000
    query_timeout_seconds: int = 120
    ai_query_timeout_seconds: int = 10
    ai_max_tool_rows: int = 50
    ai_max_steps: int = 8

    @property
    def ai_enabled(self) -> bool:
        return bool(self.openai_api_key.strip())


settings = Settings()
