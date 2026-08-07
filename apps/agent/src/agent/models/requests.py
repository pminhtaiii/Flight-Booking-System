from pydantic import BaseModel, Field, model_validator
from typing import Optional

class ChatStreamRequest(BaseModel):
    """
    Request model for the chat stream endpoint.
    """
    sessionId: Optional[str] = Field(None, alias="sessionId")
    message: Optional[str] = Field(None)
    confirmed: Optional[bool] = Field(None)

    model_config = {
        "populate_by_name": True
    }

    @model_validator(mode="after")
    def validate_request(self) -> "ChatStreamRequest":
        # If confirmed is not set, message is required and cannot be empty
        if self.confirmed is None:
            if not self.message:
                raise ValueError("Message is required when confirmed is not provided")
            stripped = self.message.strip()
            if not stripped:
                raise ValueError("Message cannot be empty or whitespace only")
            self.message = stripped
        else:
            # If confirmed is set, message is optional. If message is present, strip it.
            if self.message is not None:
                stripped = self.message.strip()
                self.message = stripped
        return self

from typing import Literal
class RouteDecision(BaseModel):
    intent: Literal["GENERAL", "SEARCH", "BOOKING_INQUIRY", "CHECKOUT"]
    confidence: float = Field(ge=0.0, le=1.0)
    isCommitment: bool
    selectionIndex: Optional[int] = None

