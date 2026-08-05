import asyncio
import logging
import time
import uuid
from dataclasses import dataclass, field
from fastapi import HTTPException
from agent.repositories.session_lock_repository import SessionLockRepository

logger = logging.getLogger("agent.queue")

background_tasks: set[asyncio.Task] = set()

@dataclass
class ActiveFence:
    req_id: str
    fence: int
    refresh_task: asyncio.Task
    user_id: str
    monitored_tasks: set[asyncio.Task] = field(default_factory=set)

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
        
        self.active_fences: dict[str, ActiveFence] = {}
        self.refresh_interval = 3.0
        self.lock_ttl_ms = 10000

    async def _cancel_monitored_tasks(self, session_id: str, req_id: str) -> None:
        async with self.manager_lock:
            active = self.active_fences.get(session_id)
            if not active or active.req_id != req_id:
                return
            tasks = list(active.monitored_tasks)
            
        for task in tasks:
            if task and not task.done():
                logger.warning(f"Cancelling task {task.get_name()} due to lost session lock for session {session_id}.")
                task.cancel()

    async def attach_task(self, session_id: str, req_id: str, task: asyncio.Task) -> bool:
        """
        Attach a worker/producer task to the active fence so that if lock refresh fails,
        the worker/producer task is also cancelled. Returns True if attached, False if fence is no longer active.
        """
        async with self.manager_lock:
            active = self.active_fences.get(session_id)
            if active and active.req_id == req_id:
                active.monitored_tasks.add(task)
                task.add_done_callback(lambda t: active.monitored_tasks.discard(t))
                return True
            return False

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

            main_task = asyncio.current_task()
            
            async def refresher():
                try:
                    while True:
                        await asyncio.sleep(self.refresh_interval)
                        try:
                            ok = await self.repo.refresh_lock(user_id, session_id, req_id, fence, ttl_ms=self.lock_ttl_ms)
                        except Exception as err:
                            logger.error(f"Redis error during session lock refresh for session {session_id}: {err!s}. Cancelling active tasks.")
                            await self._cancel_monitored_tasks(session_id, req_id)
                            break

                        if not ok:
                            logger.warning(f"Lost session lock refresh for session {session_id}. Cancelling active tasks.")
                            await self._cancel_monitored_tasks(session_id, req_id)
                            break
                except asyncio.CancelledError:
                    logger.debug(f"Lock refresh task cancelled for session {session_id}.")

            refresh_task = asyncio.create_task(refresher())
            background_tasks.add(refresh_task)
            refresh_task.add_done_callback(background_tasks.discard)
            
            active_fence = ActiveFence(
                req_id=req_id,
                fence=fence,
                refresh_task=refresh_task,
                user_id=user_id,
                monitored_tasks={main_task} if main_task else set()
            )
            if main_task:
                main_task.add_done_callback(lambda t: active_fence.monitored_tasks.discard(t))

            async with self.manager_lock:
                self.active_fences[session_id] = active_fence

            return req_id
        except BaseException:
            if 'refresh_task' in locals():
                locals()['refresh_task'].cancel()
            if fence is not None:
                rel_task = asyncio.create_task(self.repo.release_lock(user_id, session_id, req_id, fence))
                background_tasks.add(rel_task)
                rel_task.add_done_callback(background_tasks.discard)
                
            async with self.manager_lock:
                self.depths[session_id] -= 1
                if self.depths[session_id] <= 0:
                    self.depths.pop(session_id, None)
            raise

    async def release(self, session_id: str, req_id: str = None) -> None:
        """
        Release the distributed lock for session_id and decrement the local depth.
        Only decrements depth and releases lock if req_id matches the active fence
        (or if req_id is None). Stale releases for superseded requests are ignored.
        """
        active = None
        async with self.manager_lock:
            current_active = self.active_fences.get(session_id)
            if current_active and (req_id is None or current_active.req_id == req_id):
                active = self.active_fences.pop(session_id, None)
                if session_id in self.depths:
                    self.depths[session_id] -= 1
                    if self.depths[session_id] <= 0:
                        self.depths.pop(session_id, None)
            else:
                if req_id is not None:
                    logger.warning(
                        f"Ignoring stale release for session {session_id} with req_id {req_id} "
                        f"(active req_id: {current_active.req_id if current_active else None})."
                    )

        if active:
            active.refresh_task.cancel()
            await self.repo.release_lock(active.user_id, session_id, active.req_id, active.fence)
            logger.info(f"Released lock for session {session_id} (req_id: {active.req_id})")
        
    async def validate_active_fence(self, session_id: str) -> bool:
        async with self.manager_lock:
            active = self.active_fences.get(session_id)
        if active:
            return await self.repo.validate_fence(active.user_id, session_id, active.req_id, active.fence)
        return False
