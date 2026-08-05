import httpx
import jwt
from jwt import InvalidTokenError
from typing import Optional, List, Dict, Any
import logging
from agent.config import get_settings
from agent.auth.claim_token import create_claim_token

logger = logging.getLogger(__name__)

class NestJSClient:
    def __init__(self, base_url: str, token: str, correlation_id: Optional[str] = None):
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.headers = {"Authorization": f"Bearer {token}"}
        self.correlation_id = correlation_id


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

    async def get_memory(self, session_id: str, recent_count: int = 20, unsummarized_only: bool = False) -> Dict[str, Any]:
        url = f"{self.base_url}/chat/sessions/{session_id}/memory"
        params = {"recentCount": recent_count}
        if unsummarized_only:
            params["unsummarizedOnly"] = "true"
        async with httpx.AsyncClient() as client:
            response = await client.get(url, params=params, headers=self.headers)
            response.raise_for_status()
            return response.json()

    def _get_gateway_headers(self) -> dict:
        settings = get_settings()
        try:
            payload = jwt.decode(self.token, settings.JWT_SECRET, algorithms=["HS256"])
        except InvalidTokenError as exc:
            raise ValueError("Invalid authentication token") from exc
        
        user_id = payload.get("id") or payload.get("sub")
        if not user_id:
            raise ValueError("Token is missing user identification claims ('id' or 'sub')")
            
        claim_token = create_claim_token(str(user_id), settings.CLAIM_TOKEN_SECRET)
        headers = {
            "X-Agent-API-Key": settings.AGENT_SERVICE_API_KEY,
            "X-User-Claim": claim_token
        }
        if self.correlation_id:
            headers["X-Correlation-ID"] = self.correlation_id
        return headers

    async def get_gateway_flights_search(self, origin: str, destination: str, date: str, passengers: int) -> dict:
        url = f"{self.base_url}/agent-gateway/flights/search"
        params = {
            "origin": origin,
            "destination": destination,
            "date": date,
            "passengers": passengers
        }
        headers = self._get_gateway_headers()
        async with httpx.AsyncClient() as client:
            response = await client.get(url, params=params, headers=headers)
            if response.status_code == 400:
                try:
                    data = response.json()
                    message = data.get("message")
                    if message:
                        return {"error": message}
                except ValueError as e:
                    logger.warning("Failed to parse 400 response JSON in get_gateway_flights_search: %s (response: %s)", e, response.text)
            response.raise_for_status()
            return response.json()

    async def get_gateway_user_preferences(self) -> dict:
        url = f"{self.base_url}/agent-gateway/users/preferences"
        headers = self._get_gateway_headers()
        async with httpx.AsyncClient() as client:
            response = await client.get(url, headers=headers)
            response.raise_for_status()
            return response.json()

    async def get_gateway_user_bookings(self) -> dict:
        url = f"{self.base_url}/agent-gateway/users/bookings"
        headers = self._get_gateway_headers()
        async with httpx.AsyncClient() as client:
            response = await client.get(url, headers=headers)
            response.raise_for_status()
            return response.json()

