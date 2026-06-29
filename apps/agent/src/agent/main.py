import time
import httpx
from fastapi import FastAPI, Request
from agent.config import get_settings
from agent.middleware.auth import JWTAuthMiddleware
from agent.middleware.rate_limit import RateLimitMiddleware
from fastapi.middleware.cors import CORSMiddleware
from agent.guardrails.nemo import NemoGuardrailService

from contextlib import asynccontextmanager

settings = get_settings()

import asyncio
from typing import Set

# Global set to track active SSE connection queues for graceful shutdown (M2)
active_streams: Set[asyncio.Queue] = set()

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Pre-load NeMo Guardrails configuration at service startup (M6)
    app.state.guardrails = NemoGuardrailService()
    yield
    # Graceful shutdown: notify all active SSE streams
    if active_streams:
        shutdown_event = {
            "event": "error",
            "data": '{"code": "INTERNAL_ERROR", "message": "Server is shutting down. Connection closed.", "partialMessageId": null}'
        }
        for q in list(active_streams):
            try:
                q.put_nowait(shutdown_event)
            except asyncio.QueueFull:
                pass
        active_streams.clear()
        # Allow a short duration for the queues to flush
        await asyncio.sleep(0.5)

app = FastAPI(title="AI Chatbot Agent Service", version="0.1.0", lifespan=lifespan)


app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.FRONTEND_URL],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.add_middleware(
    RateLimitMiddleware,
    limit=60,
    window=60
)

app.add_middleware(
    JWTAuthMiddleware,
    secret=settings.JWT_SECRET,
    exclude_paths=["/health", "/docs", "/openapi.json", "/redoc"]
)

@app.get("/health")
async def health_check(request: Request):
    nestjs_status = "ok"
    nestjs_latency = 0
    start_time = time.time()
    try:
        async with httpx.AsyncClient() as client:
            response = await client.get(f"{settings.NESTJS_API_URL}/health", timeout=2.0)
            if response.status_code != 200:
                nestjs_status = "down"
    except Exception:
        nestjs_status = "down"
    
    nestjs_latency = int((time.time() - start_time) * 1000)

    guardrails = getattr(request.app.state, "guardrails", None)
    
    if guardrails is not None and settings.MIMO_API_URL and settings.MIMO_API_KEY:
        guardrails_status = "ok" if guardrails.is_healthy() else "down"
        model_loaded = guardrails.is_healthy()
        llm_status = "ok" if guardrails.is_healthy() else "down"
    else:
        guardrails_status = "not_configured"
        model_loaded = False
        llm_status = "not_configured"

    llm_latency = None

    overall_status = "ok"
    if nestjs_status == "down" or guardrails_status == "down":
        overall_status = "degraded"

    return {
        "status": overall_status,
        "dependencies": {
            "llm": {"status": llm_status, "latencyMs": llm_latency},
            "nestjsApi": {"status": nestjs_status, "latencyMs": nestjs_latency},
            "guardrails": {"status": guardrails_status, "modelLoaded": model_loaded}
        },
        "version": "0.1.0"
    }
