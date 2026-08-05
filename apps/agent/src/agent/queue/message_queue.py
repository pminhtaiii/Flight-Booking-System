import asyncio
import logging
import time
import uuid
from fastapi import HTTPException
from agent.repositories.session_lock_repository import SessionLockRepository

logger = logging.getLogger("agent.queue")

class MessageQueueManager:
    """
    Manages per-session locks and request depths to queue concurrent requests 
    and reject requests exceeding the maximum allowed depth.
    Uses SessionLockRepository for distributed locking and refresh-loss cancellation.
    """
    def __init__(self, max_depth: int = 3):
        self.max_depth = max_depth
        self.depths: dict[str, int] = {}
        self.manager_lock = asyncio.Lock()
        self.repo = SessionLockRepository()
        
        # Maps session_id to (req_id, fence, refresh_task, user_id)
        self.active_fences: dict[str, tuple[str, int, asyncio.Task, str]] = {}
        self.refresh_interval = 3.0
        self.lock_ttl_ms = 10000

    async def acquire(self, session_id: str, user_id: str = "default") -> str:
        """
        Increment the depth for a session_id. If the depth is already at or above
        max_depth, raises an HTTPException (429).
        Otherwise, waits boundedly to acquire the distributed lock for session_id.
        Starts a background task to refresh the lock. If refresh is lost, cancels the caller.
        """
        async with self.manager_lock:
            depth = self.depths.get(session_id, 0)
            if depth >= self.max_depth:
                logger.warning(
                    f"Queue depth limit ({self.max_depth}) exceeded for session {session_id}."
                )
                raise HTTPException(
                    status_code=429,
                    detail="Too many concurrent requests for this conversation. Please wait."
                )
            self.depths[session_id] = depth + 1

        logger.info(f"Acquiring lock for session {session_id} (depth: {depth + 1})")
        req_id = str(uuid.uuid4())
        
        # Bounded wait for the distributed lock
        timeout = 30.0
        start_time = time.time()
        fence = None
        
        try:
            while time.time() - start_time < timeout:
                fence = await self.repo.acquire_lock(user_id, session_id, req_id, ttl_ms=self.lock_ttl_ms)
                if fence is not None:
                    break
                await asyncio.sleep(0.1)
                
            if fence is None:
                raise HTTPException(status_code=429, detail="Could not acquire session lock.")
        except BaseException:
            async with self.manager_lock:
                self.depths[session_id] -= 1
                if self.depths[session_id] <= 0:
                    self.depths.pop(session_id, None)
            raise

        main_task = asyncio.current_task()
        
        async def refresher():
            try:
                while True:
                    await asyncio.sleep(self.refresh_interval)
                    ok = await self.repo.refresh_lock(user_id, session_id, req_id, fence, ttl_ms=self.lock_ttl_ms)
                    if not ok:
                        logger.warning(f"Lost session lock refresh for session {session_id}. Cancelling request.")
                        if main_task and not main_task.done():
                            main_task.cancel()
                        break
            except asyncio.CancelledError:
                pass

        refresh_task = asyncio.create_task(refresher())
        
        async with self.manager_lock:
            self.active_fences[session_id] = (req_id, fence, refresh_task, user_id)

        return req_id

    async def release(self, session_id: str, req_id: str = None) -> None:
        """
        Release the distributed lock for session_id and decrement the local depth.
        """
        async with self.manager_lock:
            if session_id in self.depths:
                self.depths[session_id] -= 1
                if self.depths[session_id] <= 0:
                    self.depths.pop(session_id, None)
                    
            active = self.active_fences.get(session_id)
            if active and (req_id is None or active[0] == req_id):
                self.active_fences.pop(session_id, None)
            else:
                active = None
            
        if active:
            active_req_id, fence, refresh_task, user_id = active
            refresh_task.cancel()
            await self.repo.release_lock(user_id, session_id, active_req_id, fence)
            
        logger.info(f"Released lock for session {session_id}")
        
    async def validate_active_fence(self, session_id: str) -> bool:
        async with self.manager_lock:
            active = self.active_fences.get(session_id)
        if active:
            req_id, fence, refresh_task, user_id = active
            return await self.repo.validate_fence(user_id, session_id, req_id, fence)
        return False
