from pydantic_settings import BaseSettings, SettingsConfigDict
from pydantic import Field
from typing import Optional

class Settings(BaseSettings):
    JWT_SECRET: str = Field(..., min_length=1)
    FRONTEND_URL: str = "http://localhost:3000"
    NESTJS_API_URL: str
    MIMO_API_URL: Optional[str] = None
    MIMO_API_KEY: Optional[str] = None
    MIMO_MODEL_NAME: str = "mimo"
    LANGCHAIN_TRACING_V2: str = "false"
    LANGCHAIN_API_KEY: Optional[str] = None
    LANGCHAIN_PROJECT: Optional[str] = None
    AGENT_PORT: int = 3002
    MAX_MESSAGE_LENGTH: int = 10000
    MEMORY_WINDOW_SIZE: int = 20
    MEMORY_TOKEN_BUDGET: int = 4000
    QUEUE_MAX_DEPTH: int = 3

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore"
    )

settings: Optional[Settings] = None

def get_settings() -> Settings:
    global settings
    if settings is None:
        settings = Settings()
    return settings
