from pydantic import BaseModel, Field, field_validator
from typing import Optional

class ChatStreamRequest(BaseModel):
    """
    Request model for the chat stream endpoint.
    """
    sessionId: Optional[str] = Field(None, alias="sessionId")
    message: str = Field(..., min_length=1)

    model_config = {
        "populate_by_name": True
    }

    @field_validator("message")
    @classmethod
    def validate_message(cls, v: str) -> str:
        stripped = v.strip()
        if not stripped:
            raise ValueError("Message cannot be empty or whitespace only")
        return stripped
