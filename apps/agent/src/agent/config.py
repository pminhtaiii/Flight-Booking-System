from pydantic_settings import BaseSettings, SettingsConfigDict
from pydantic import Field, BaseModel
from typing import Optional

class OutputGuardrailConfig(BaseModel):
    enabled: bool = True
    overlap_tokens: int = 30
    max_chunk_tokens: int = 200
    nemo_timeout: float = 2.0

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

    AGENT_SERVICE_API_KEY: str = Field(..., min_length=1)
    CLAIM_TOKEN_SECRET: str = Field(..., min_length=1)
    CLAIM_TOKEN_TTL_SECONDS: int = 300
    AGENT_MAX_ITERATIONS: int = 5

    OUTPUT_GUARDRAIL_ENABLED: bool = True
    OUTPUT_GUARDRAIL_OVERLAP_TOKENS: int = 30
    OUTPUT_GUARDRAIL_MAX_CHUNK_TOKENS: int = 200
    OUTPUT_GUARDRAIL_NEMO_TIMEOUT: float = 2.0

    @property
    def output_guardrail(self) -> OutputGuardrailConfig:
        return OutputGuardrailConfig(
            enabled=self.OUTPUT_GUARDRAIL_ENABLED,
            overlap_tokens=self.OUTPUT_GUARDRAIL_OVERLAP_TOKENS,
            max_chunk_tokens=self.OUTPUT_GUARDRAIL_MAX_CHUNK_TOKENS,
            nemo_timeout=self.OUTPUT_GUARDRAIL_NEMO_TIMEOUT
        )

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

