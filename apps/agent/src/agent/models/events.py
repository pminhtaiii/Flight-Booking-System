from pydantic import BaseModel, Field, ConfigDict
from typing import Literal

class BaseSSEEvent(BaseModel):
    version: Literal[1]
    action: str

class DisplayInfo(BaseModel):
    airline: str
    origin: str
    destination: str
    departureAt: str
    arrivalAt: str
    price: str
    currency: str

class HandoffEvent(BaseSSEEvent):
    action: Literal["begin_checkout"]
    handoffToken: str
    expiresAt: str
    display: DisplayInfo
    
    model_config = ConfigDict(extra="forbid")

class ActionRequiredEvent(BaseSSEEvent):
    action: Literal["action_required"]
    message: str

class ChatMessageEvent(BaseSSEEvent):
    action: Literal["chat_message"]
    content: str
    role: Literal["assistant", "system", "user"]
