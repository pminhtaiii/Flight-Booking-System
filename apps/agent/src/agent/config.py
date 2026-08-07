from pydantic_settings import BaseSettings, SettingsConfigDict
from pydantic import Field, BaseModel, model_validator
from typing import Optional

DEFAULT_OUTPUT_GUARDRAIL_ENABLED = True
DEFAULT_OUTPUT_GUARDRAIL_OVERLAP_TOKENS = 30
DEFAULT_OUTPUT_GUARDRAIL_MAX_CHUNK_TOKENS = 200
DEFAULT_OUTPUT_GUARDRAIL_NEMO_TIMEOUT = 2.0

class OutputGuardrailConfig(BaseModel):
    enabled: bool = DEFAULT_OUTPUT_GUARDRAIL_ENABLED
    overlap_tokens: int = DEFAULT_OUTPUT_GUARDRAIL_OVERLAP_TOKENS
    max_chunk_tokens: int = DEFAULT_OUTPUT_GUARDRAIL_MAX_CHUNK_TOKENS
    nemo_timeout: float = DEFAULT_OUTPUT_GUARDRAIL_NEMO_TIMEOUT

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

    OUTPUT_GUARDRAIL_ENABLED: bool = DEFAULT_OUTPUT_GUARDRAIL_ENABLED
    OUTPUT_GUARDRAIL_OVERLAP_TOKENS: int = DEFAULT_OUTPUT_GUARDRAIL_OVERLAP_TOKENS
    OUTPUT_GUARDRAIL_MAX_CHUNK_TOKENS: int = DEFAULT_OUTPUT_GUARDRAIL_MAX_CHUNK_TOKENS
    OUTPUT_GUARDRAIL_NEMO_TIMEOUT: float = DEFAULT_OUTPUT_GUARDRAIL_NEMO_TIMEOUT

    FEATURE_FLAG_CHAT_MULTI_AGENT: bool = False
    FEATURE_FLAG_CHAT_HANDOFF_ACCEPT: bool = False
    FEATURE_FLAG_CHAT_HANDOFF_ISSUE: bool = False
    FEATURE_FLAG_CHAT_DIRECT_STREAM: bool = False
    REDIS_URL: Optional[str] = "redis://localhost:6379/0"
    CHAT_QUOTA_DAILY: int = 50
    CHAT_QUOTA_BURST: int = 60
    ROUTER_CONFIDENCE_THRESHOLD: float = 0.7
    SNAPSHOT_TTL_SECONDS: int = 1800

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

    @model_validator(mode="after")
    def validate_handoff_flags(self) -> 'Settings':
        if self.FEATURE_FLAG_CHAT_HANDOFF_ISSUE and not self.FEATURE_FLAG_CHAT_HANDOFF_ACCEPT:
            raise ValueError("Invalid config: ISSUE=true but ACCEPT=false")
        return self

settings: Optional[Settings] = None

def get_settings() -> Settings:
    global settings
    if settings is None:
        settings = Settings()
    return settings

