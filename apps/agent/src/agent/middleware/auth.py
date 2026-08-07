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
        if request.method == "OPTIONS":
            return await call_next(request)

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
        from agent.config import get_settings
        settings = get_settings()
        issuer = getattr(settings, "JWT_ISSUER", "booking-systems-api")
        audience = getattr(settings, "JWT_AUDIENCE", "booking-systems-clients")

        try:
            payload = jwt.decode(
                token,
                self.secret,
                algorithms=["HS256"],
                issuer=issuer,
                audience=audience,
                options={"verify_iss": True, "verify_aud": True},
            )
            sub = payload.get("sub") or payload.get("id")
            jti = payload.get("jti")
            if not sub or not jti:
                return JSONResponse(
                    status_code=401,
                    content={"detail": "Invalid token"}
                )
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
