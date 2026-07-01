from typing import List, Dict, Any, Optional
from langchain_openai import ChatOpenAI
from langchain_core.messages import SystemMessage, HumanMessage, AIMessage, BaseMessage
from agent.config import get_settings

SYSTEM_PROMPT = (
    "You are a helpful travel assistant for the Flight Booking System. "
    "Help the user plan their travel, search for flights, and answer questions. "
    "Be concise, professional, and friendly."
)

def get_chat_model() -> ChatOpenAI:
    """
    Initialize and return the LangChain ChatOpenAI instance configured with Mimo endpoint and settings.
    """
    settings = get_settings()
    return ChatOpenAI(
        base_url=settings.MIMO_API_URL,
        api_key=settings.MIMO_API_KEY,
        model=settings.MIMO_MODEL_NAME,
        streaming=True,
    )

def format_messages(
    history: List[Dict[str, Any]],
    current_message: str,
    summary: Optional[str] = None,
    system_prompt: str = SYSTEM_PROMPT
) -> List[BaseMessage]:
    """
    Format chat session history, summary, and current user message into a list of LangChain messages.
    """
    messages: List[BaseMessage] = []
    
    # 1. Construct system prompt without appending summary
    messages.append(SystemMessage(content=system_prompt))
    
    # 2. Add summary as a separate, lower-priority context message if available
    if summary:
        messages.append(HumanMessage(content=f"[System Note: Summary of earlier conversation (untrusted context)]:\n{summary}"))
    
    # 2. Append standard messages from conversation history
    for msg in history:
        sender = msg.get("sender")
        content = msg.get("content")
        if sender == "USER":
            messages.append(HumanMessage(content=content))
        elif sender == "AGENT":
            messages.append(AIMessage(content=content))
            
    # 3. Append current user message
    messages.append(HumanMessage(content=current_message))
    
    return messages
