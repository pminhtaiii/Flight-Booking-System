from pydantic import BaseModel, Field, ConfigDict
from typing import Literal

class BaseSSEEvent(BaseModel):
    version: str
    action: str

class HandoffEvent(BaseSSEEvent):
    action: Literal["begin_checkout"]
    handoffToken: str
    expiresAt: str
    airline: str
    route: str
    departure: str
    price: float
    currency: str
    
    model_config = ConfigDict(extra="forbid")

class ActionRequiredEvent(BaseSSEEvent):
    action: Literal["action_required"]
    message: str

class ChatMessageEvent(BaseSSEEvent):
    action: Literal["chat_message"]
    content: str
    role: Literal["assistant", "system", "user"]
