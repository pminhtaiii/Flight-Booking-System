import jwt
from fastapi import Request, Response
from starlette.middleware.base import BaseHTTPMiddleware
from fastapi.responses import JSONResponse
from typing import List, Optional

class JWTAuthMiddleware(BaseHTTPMiddleware):
    def __init__(self, app, secret: str, exclude_paths: Optional[List[str]] = None):
        super().__init__(app)
        self.secret = secret
        self.exclude_paths = exclude_paths or []

    async def dispatch(self, request: Request, call_next) -> Response:
        path = request.url.path
        if any(
            path == normalized or path.startswith(f"{normalized}/")
            for normalized in ((p.rstrip("/") or "/") for p in self.exclude_paths)
        ):
            return await call_next(request)

        auth_header = request.headers.get("Authorization")
        if not auth_header:
            return JSONResponse(
                status_code=401,
                content={"detail": "Missing authorization header"}
            )

        parts = auth_header.split()
        if len(parts) != 2 or parts[0].lower() != "bearer":
            return JSONResponse(
                status_code=401,
                content={"detail": "Invalid authorization header format"}
            )

        token = parts[1]
        try:
            payload = jwt.decode(token, self.secret, algorithms=["HS256"])
            request.state.user = payload
        except jwt.ExpiredSignatureError:
            return JSONResponse(
                status_code=401,
                content={"detail": "Token has expired"}
            )
        except jwt.InvalidTokenError:
            return JSONResponse(
                status_code=401,
                content={"detail": "Invalid token"}
            )

        return await call_next(request)
