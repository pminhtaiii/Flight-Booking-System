import asyncio
import logging
from fastapi import HTTPException

logger = logging.getLogger("agent.queue")

class MessageQueueManager:
    def __init__(self, max_depth: int = 3):
        self.max_depth = max_depth
        self.locks: dict[str, asyncio.Lock] = {}
        self.depths: dict[str, int] = {}
        self.manager_lock = asyncio.Lock()

    async def acquire(self, session_id: str) -> None:
        """
        Increment the depth for a session_id. If the depth is already at or above
        max_depth, raises an HTTPException (429).
        Otherwise, waits to acquire the lock for session_id.
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
            if session_id not in self.locks:
                self.locks[session_id] = asyncio.Lock()
            lock = self.locks[session_id]

        logger.info(f"Acquiring lock for session {session_id} (depth: {depth + 1})")
        try:
            await lock.acquire()
        except asyncio.CancelledError:
            # If the waiter is cancelled before acquiring the lock, decrement the depth
            async with self.manager_lock:
                self.depths[session_id] -= 1
                if self.depths[session_id] <= 0:
                    self.depths.pop(session_id, None)
                    self.locks.pop(session_id, None)
            raise

    async def release(self, session_id: str) -> None:
        """
        Release the lock for session_id and decrement the depth.
        """
        async with self.manager_lock:
            lock = self.locks.get(session_id)
            if lock and lock.locked():
                lock.release()
            if session_id in self.depths:
                self.depths[session_id] -= 1
                if self.depths[session_id] <= 0:
                    self.depths.pop(session_id, None)
                    self.locks.pop(session_id, None)
        logger.info(f"Released lock for session {session_id}")
