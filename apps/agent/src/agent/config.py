import os
from typing import Optional, Union

from pydantic import BaseModel, Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

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
    SESSION_LOCK_TTL_MS: int = 10000
    SESSION_LOCK_REFRESH_INTERVAL_SECONDS: float = 3.0
    SHUTDOWN_TIMEOUT_SECONDS: float = 5.0

    AGENT_SERVICE_API_KEY: str = Field(..., min_length=1)
    CLAIM_TOKEN_SECRET: str = Field(..., min_length=1)
    CLAIM_TOKEN_SECRET_CURRENT: Optional[str] = None
    CLAIM_TOKEN_SECRET_PREVIOUS: Optional[str] = None
    CLAIM_TOKEN_SECRET_V2: Optional[str] = None
    CLAIM_TOKEN_SECRET_V1: Optional[str] = None

    JWT_SECRET_CURRENT: Optional[str] = None
    JWT_SECRET_PREVIOUS: Optional[str] = None
    JWT_SECRET_V2: Optional[str] = None
    JWT_SECRET_V1: Optional[str] = None

    CLAIM_TOKEN_TTL_SECONDS: int = 300
    AGENT_MAX_ITERATIONS: int = 5

    @property
    def jwt_secret_ring(self) -> list[str]:
        keys = [
            self.JWT_SECRET_CURRENT,
            self.JWT_SECRET,
            self.JWT_SECRET_PREVIOUS,
            self.JWT_SECRET_V2,
            self.JWT_SECRET_V1,
        ]
        ring: list[str] = []
        for k in keys:
            if k and isinstance(k, str) and k.strip() and k.strip() not in ring:
                ring.append(k.strip())
        return ring if ring else [self.JWT_SECRET]

    @property
    def primary_claim_token_secret(self) -> str:
        return self.CLAIM_TOKEN_SECRET_CURRENT or self.CLAIM_TOKEN_SECRET

    @property
    def claim_token_secret_ring(self) -> list[str]:
        keys = [
            self.CLAIM_TOKEN_SECRET_CURRENT,
            self.CLAIM_TOKEN_SECRET,
            self.CLAIM_TOKEN_SECRET_PREVIOUS,
            self.CLAIM_TOKEN_SECRET_V2,
            self.CLAIM_TOKEN_SECRET_V1,
        ]
        ring: list[str] = []
        for k in keys:
            if k and isinstance(k, str) and k.strip() and k.strip() not in ring:
                ring.append(k.strip())
        return ring if ring else [self.CLAIM_TOKEN_SECRET]

    OUTPUT_GUARDRAIL_ENABLED: bool = DEFAULT_OUTPUT_GUARDRAIL_ENABLED
    OUTPUT_GUARDRAIL_OVERLAP_TOKENS: int = DEFAULT_OUTPUT_GUARDRAIL_OVERLAP_TOKENS
    OUTPUT_GUARDRAIL_MAX_CHUNK_TOKENS: int = DEFAULT_OUTPUT_GUARDRAIL_MAX_CHUNK_TOKENS
    OUTPUT_GUARDRAIL_NEMO_TIMEOUT: float = DEFAULT_OUTPUT_GUARDRAIL_NEMO_TIMEOUT

    FEATURE_FLAG_CHAT_MULTI_AGENT: bool = False
    FEATURE_FLAG_CHAT_HANDOFF_ACCEPT: bool = False
    FEATURE_FLAG_CHAT_HANDOFF_ISSUE: bool = False
    FEATURE_FLAG_CHAT_DIRECT_STREAM: Optional[Union[bool, str]] = None
    ENABLE_DIRECT_AGENT_STREAM: Optional[Union[bool, str]] = None
    CHAT_STREAM_TRANSPORT: Optional[str] = None
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
            nemo_timeout=self.OUTPUT_GUARDRAIL_NEMO_TIMEOUT,
        )

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    @model_validator(mode="after")
    def validate_settings(self) -> "Settings":
        legacy_env_flags = [
            os.getenv("FEATURE_FLAG_CHAT_DIRECT_STREAM"),
            os.getenv("ENABLE_DIRECT_AGENT_STREAM"),
            os.getenv("NEXT_PUBLIC_FEATURE_FLAG_CHAT_DIRECT_STREAM"),
            os.getenv("NEXT_PUBLIC_ENABLE_DIRECT_AGENT_STREAM"),
        ]
        for val in legacy_env_flags:
            if val is not None and str(val).strip().lower() == "false":
                raise ValueError(
                    "Legacy proxy transport is decommissioned. Direct-only streaming transport is mandatory."
                )

        env_transport = os.getenv("CHAT_STREAM_TRANSPORT")
        if env_transport is not None and str(env_transport).strip().lower() in (
            "proxy",
            "legacy",
            "false",
        ):
            raise ValueError(
                "Legacy proxy transport is decommissioned. Direct-only streaming transport is mandatory."
            )

        if self.FEATURE_FLAG_CHAT_DIRECT_STREAM is False or (
            isinstance(self.FEATURE_FLAG_CHAT_DIRECT_STREAM, str)
            and self.FEATURE_FLAG_CHAT_DIRECT_STREAM.strip().lower() == "false"
        ):
            raise ValueError(
                "Legacy proxy transport is decommissioned. Direct-only streaming transport is mandatory."
            )

        if self.ENABLE_DIRECT_AGENT_STREAM is False or (
            isinstance(self.ENABLE_DIRECT_AGENT_STREAM, str)
            and self.ENABLE_DIRECT_AGENT_STREAM.strip().lower() == "false"
        ):
            raise ValueError(
                "Legacy proxy transport is decommissioned. Direct-only streaming transport is mandatory."
            )

        if self.CHAT_STREAM_TRANSPORT is not None and str(
            self.CHAT_STREAM_TRANSPORT
        ).strip().lower() in ("proxy", "legacy", "false"):
            raise ValueError(
                "Legacy proxy transport is decommissioned. Direct-only streaming transport is mandatory."
            )

        if self.FEATURE_FLAG_CHAT_HANDOFF_ISSUE and not self.FEATURE_FLAG_CHAT_HANDOFF_ACCEPT:
            raise ValueError("Invalid config: ISSUE=true but ACCEPT=false")
        if self.SESSION_LOCK_TTL_MS <= 0:
            raise ValueError("SESSION_LOCK_TTL_MS must be positive")
        if self.SESSION_LOCK_REFRESH_INTERVAL_SECONDS <= 0:
            raise ValueError("SESSION_LOCK_REFRESH_INTERVAL_SECONDS must be positive")
        if self.SESSION_LOCK_REFRESH_INTERVAL_SECONDS * 1000 >= self.SESSION_LOCK_TTL_MS:
            raise ValueError("Refresh interval must be less than TTL")
        return self


settings: Optional[Settings] = None


def get_settings() -> Settings:
    global settings
    if settings is None:
        settings = Settings()
    return settings
