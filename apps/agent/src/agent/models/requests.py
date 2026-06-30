from pydantic import BaseModel, Field
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
