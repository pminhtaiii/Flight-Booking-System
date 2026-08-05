import redis.asyncio as redis
from datetime import datetime, timezone
import json
from pydantic import ValidationError
from typing import Optional
from agent.models.snapshot import TrustedSearchSnapshot

class TrustedSnapshotRepository:
    def __init__(self, redis_client: redis.Redis):
        self.redis = redis_client

    def _get_key(self, user_id: str, session_id: str) -> str:
        return f"chat:snapshot:{user_id}:{session_id}"

    def _serialize_snapshot(self, snapshot: TrustedSearchSnapshot) -> str:
        data = snapshot.model_dump()
        data["createdAt"] = snapshot.createdAt.isoformat()
        data["expiresAt"] = snapshot.expiresAt.isoformat()
        if "results" in data and isinstance(data["results"], list):
            for res_dict, res_obj in zip(data["results"], snapshot.results):
                res_dict["departureAt"] = res_obj.departureAt.isoformat()
                res_dict["arrivalAt"] = res_obj.arrivalAt.isoformat()
        return json.dumps(data)

    def _deserialize_snapshot(self, data_str: str) -> Optional[TrustedSearchSnapshot]:
        raw = json.loads(data_str)
        if isinstance(raw.get("createdAt"), str):
            raw["createdAt"] = datetime.fromisoformat(raw["createdAt"])
        if isinstance(raw.get("expiresAt"), str):
            raw["expiresAt"] = datetime.fromisoformat(raw["expiresAt"])
        if isinstance(raw.get("results"), list):
            for res in raw["results"]:
                if isinstance(res.get("departureAt"), str):
                    res["departureAt"] = datetime.fromisoformat(res["departureAt"])
                if isinstance(res.get("arrivalAt"), str):
                    res["arrivalAt"] = datetime.fromisoformat(res["arrivalAt"])
        return TrustedSearchSnapshot.model_validate(raw)

    async def save_snapshot(self, snapshot: TrustedSearchSnapshot, max_ttl: int = 3600) -> None:
        """
        Atomically replaces the old snapshot and sets the TTL based on expiresAt.
        """
        now = datetime.now(timezone.utc)
        expires_at = snapshot.expiresAt
        
        # Calculate TTL
        ttl_seconds = int((expires_at - now).total_seconds())
        if ttl_seconds <= 0:
            return  # already expired, don't save
            
        ttl = min(ttl_seconds, max_ttl)
        
        key = self._get_key(snapshot.userId, snapshot.sessionId)
        
        # Use json format 
        data = self._serialize_snapshot(snapshot)
        
        await self.redis.set(key, data, ex=ttl)

    async def get_snapshot(self, user_id: str, session_id: str) -> Optional[TrustedSearchSnapshot]:
        """
        Loads the snapshot and verifies owner/session match.
        """
        key = self._get_key(user_id, session_id)
        data = await self.redis.get(key)
        
        if not data:
            return None
            
        try:
            snapshot = self._deserialize_snapshot(data)
            # Verify owner/session
            if snapshot is None or snapshot.userId != user_id or snapshot.sessionId != session_id:
                return None
            return snapshot
        except (ValidationError, ValueError, KeyError):
            return None

    async def delete_snapshot(self, user_id: str, session_id: str) -> None:
        """
        Atomically delete the snapshot.
        """
        key = self._get_key(user_id, session_id)
        await self.redis.delete(key)
