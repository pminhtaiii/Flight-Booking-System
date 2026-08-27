import asyncio
import time
from contextlib import asynccontextmanager
from typing import Set

import httpx
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware

from agent.config import get_settings
from agent.guardrails.nemo import NemoGuardrailService
from agent.middleware.auth import JWTAuthMiddleware
from agent.streaming.sse import router as sse_router

settings = get_settings()

# Global set to track active SSE connection queues for graceful shutdown (M2)
active_streams: Set[asyncio.Queue] = set()
active_runners: Set[asyncio.Task] = set()


@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    Lifespan context manager that initializes NeMo Guardrails configuration,
    message queue manager, and Redis on startup, and flushes active SSE connections on shutdown.
    """
    from agent.infrastructure.redis import close_redis, init_redis

    if settings.REDIS_URL:
        await init_redis(settings.REDIS_URL)

    # Pre-load NeMo Guardrails configuration at service startup (M6)
    guardrails = NemoGuardrailService()
    app.state.guardrails = guardrails
    # Run async probe on startup
    await guardrails.probe()
    # Initialize message queue manager
    from agent.queue.message_queue import MessageQueueManager

    app.state.message_queue = MessageQueueManager(
        max_depth=settings.QUEUE_MAX_DEPTH,
        lock_ttl_ms=settings.SESSION_LOCK_TTL_MS,
        refresh_interval=settings.SESSION_LOCK_REFRESH_INTERVAL_SECONDS,
    )
    yield
    # Graceful shutdown: cancel and await all active runner tasks
    if active_runners:
        tasks_to_cancel = [t for t in active_runners if not t.done()]
        for t in tasks_to_cancel:
            t.cancel()
        if tasks_to_cancel:
            shutdown_timeout = getattr(settings, "SHUTDOWN_TIMEOUT_SECONDS", 5.0)
            try:
                await asyncio.wait_for(
                    asyncio.gather(*tasks_to_cancel, return_exceptions=True),
                    timeout=shutdown_timeout,
                )
            except (asyncio.TimeoutError, Exception):
                pass
        active_runners.clear()

    if active_streams:
        shutdown_event = {
            "event": "error",
            "data": '{"code": "INTERNAL_ERROR", "message": "Server is shutting down. Connection closed.", "partialMessageId": null}',
        }
        for q in list(active_streams):
            try:
                q.put_nowait(shutdown_event)
            except asyncio.QueueFull:
                pass
        active_streams.clear()
        await asyncio.sleep(0.5)

    await close_redis()


app = FastAPI(title="AI Chatbot Agent Service", version="0.1.0", lifespan=lifespan)
app.include_router(sse_router)

allowed_origins = [url.strip() for url in settings.FRONTEND_URL.split(",") if url.strip()]

app.add_middleware(
    JWTAuthMiddleware,
    secret=settings.JWT_SECRET,
    exclude_paths=["/health", "/health/live", "/docs", "/openapi.json", "/redoc"],
)


@app.middleware("http")
async def validate_origin_middleware(request: Request, call_next):
    origin = request.headers.get("origin")
    if origin and origin not in allowed_origins:
        from fastapi.responses import JSONResponse

        return JSONResponse(status_code=403, content={"detail": "ORIGIN_NOT_ALLOWED"})
    return await call_next(request)


app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=False,
    allow_methods=["POST", "OPTIONS"],
    allow_headers=[
        "Authorization",
        "Content-Type",
        "Accept",
        "X-Trace-Id",
        "X-Correlation-Id",
        "x-trace-id",
        "x-correlation-id",
    ],
)


@app.get("/health/live")
async def health_live() -> dict[str, str]:
    """Lightweight liveness probe for orchestrators and upstream health clients.

    Performs zero LLM inference, guardrail checks, or network I/O.
    """
    return {"status": "ok"}


@app.get("/health")
async def health_check(request: Request):
    """
    Perform a health check verification by checking NestJS, Redis, and NeMo Guardrails status.
    """
    nestjs_status = "ok"
    nestjs_latency = 0
    start_time = time.time()
    try:
        async with httpx.AsyncClient() as client:
            base_url = settings.NESTJS_API_URL
            if base_url.endswith("/api"):
                base_url = base_url[:-4]
            elif base_url.endswith("/api/"):
                base_url = base_url[:-5]
            response = await client.get(f"{base_url.rstrip('/')}/health", timeout=2.0)
            if response.status_code != 200:
                nestjs_status = "down"
    except Exception:
        nestjs_status = "down"

    nestjs_latency = int((time.time() - start_time) * 1000)

    guardrails = getattr(request.app.state, "guardrails", None)

    guardrails_configured = bool(
        guardrails is not None and settings.MIMO_API_URL and settings.MIMO_API_KEY
    )
    guardrails_healthy = guardrails.is_healthy() if guardrails_configured else False

    if guardrails_configured:
        guardrails_status = "ok" if guardrails_healthy else "down"
        model_loaded = guardrails_healthy
        llm_status = "ok" if guardrails_healthy else "down"
    else:
        guardrails_status = "not_configured"
        model_loaded = False
        llm_status = "not_configured"

    llm_latency = None

    redis_status = "ok"
    try:
        from agent.infrastructure.redis import get_redis_client

        client = get_redis_client()
        if client is not None:
            await client.ping()
        else:
            redis_status = "down"
    except Exception as e:
        import logging

        logging.getLogger("agent.main").error(f"Redis health check failed: {e!s}")
        redis_status = "down"

    overall_status = "ok"
    if (
        nestjs_status == "down"
        or redis_status == "down"
        or not guardrails_configured
        or not guardrails_healthy
    ):
        overall_status = "degraded"

    return {
        "status": overall_status,
        "dependencies": {
            "llm": {"status": llm_status, "latencyMs": llm_latency},
            "nestjsApi": {"status": nestjs_status, "latencyMs": nestjs_latency},
            "guardrails": {"status": guardrails_status, "modelLoaded": model_loaded},
            "redis": {"status": redis_status},
        },
        "version": "0.1.0",
    }
