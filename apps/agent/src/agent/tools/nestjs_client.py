import httpx
from typing import Optional, List, Dict, Any

class NestJSClient:
    def __init__(self, base_url: str, token: str):
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.headers = {"Authorization": f"Bearer {token}"}

    async def create_session(self, title: Optional[str] = None) -> Dict[str, Any]:
        url = f"{self.base_url}/chat/sessions"
        payload = {"title": title}
        async with httpx.AsyncClient() as client:
            response = await client.post(url, json=payload, headers=self.headers)
            response.raise_for_status()
            return response.json()

    async def create_message(
        self,
        session_id: str,
        sender: str,
        message_type: str,
        content: str
    ) -> Dict[str, Any]:
        url = f"{self.base_url}/chat/sessions/{session_id}/messages"
        payload = {
            "sender": sender,
            "type": message_type,
            "content": content
        }
        async with httpx.AsyncClient() as client:
            response = await client.post(url, json=payload, headers=self.headers)
            response.raise_for_status()
            return response.json()

    async def create_message_batch(
        self,
        session_id: str,
        messages: List[Dict[str, Any]]
    ) -> Dict[str, Any]:
        url = f"{self.base_url}/chat/sessions/{session_id}/messages/batch"
        payload = {"messages": messages}
        async with httpx.AsyncClient() as client:
            response = await client.post(url, json=payload, headers=self.headers)
            response.raise_for_status()
            return response.json()

    async def get_memory(self, session_id: str, recent_count: int = 20) -> Dict[str, Any]:
        url = f"{self.base_url}/chat/sessions/{session_id}/memory"
        params = {"recentCount": recent_count}
        async with httpx.AsyncClient() as client:
            response = await client.get(url, params=params, headers=self.headers)
            response.raise_for_status()
            return response.json()
