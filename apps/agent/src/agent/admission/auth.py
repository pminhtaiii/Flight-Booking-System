from collections.abc import Callable
from dataclasses import dataclass

from fastapi import HTTPException

from agent.config import Settings, get_settings
from agent.observability.chat_observability import safe_opaque_id
from agent.tools.nestjs_client import NestJSClient
from agent.utils.auth import decode_and_verify_jwt


@dataclass(frozen=True)
class AuthenticatedUser:
    user_id: str
    token: str
    trace_id: str
    correlation_id: str
    jti: str | None = None


class AuthService:
    def __init__(
        self,
        settings: Settings | None = None,
        client_factory: Callable[..., NestJSClient] | type[NestJSClient] | None = None,
    ) -> None:
        self.settings: Settings = settings or get_settings()
        self.client_factory: Callable[..., NestJSClient] | type[NestJSClient] = (
            client_factory or NestJSClient
        )

    async def authenticate(
        self,
        authorization: str | None,
        x_trace_id: str | None = None,
        x_correlation_id: str | None = None,
    ) -> AuthenticatedUser:
        if not authorization or not authorization.startswith("Bearer "):
            raise HTTPException(
                status_code=401,
                detail="Invalid authorization header",
            )

        token = authorization.split(" ", 1)[1]
        issuer: str = getattr(self.settings, "JWT_ISSUER", "booking-systems-api")
        audience: str = getattr(self.settings, "JWT_AUDIENCE", "booking-systems-clients")
        secrets_to_try: list[str] | str = (
            self.settings.jwt_secret_ring
            if hasattr(self.settings, "jwt_secret_ring")
            else self.settings.JWT_SECRET
        )

        try:
            payload = decode_and_verify_jwt(
                token=token,
                secret=secrets_to_try,
                issuer=issuer,
                audience=audience,
            )
            raw_sub = payload.get("sub") or payload.get("id")
            user_id = str(raw_sub) if raw_sub is not None else ""
            raw_jti = payload.get("jti")
            jti = str(raw_jti) if raw_jti is not None else None
            if not user_id:
                raise ValueError("Missing user id in token claims")
        except Exception as err:
            raise HTTPException(status_code=401, detail="Invalid token") from err

        trace_id = safe_opaque_id(x_trace_id)
        correlation_id = safe_opaque_id(x_correlation_id)

        client = self.client_factory(
            base_url=self.settings.NESTJS_API_URL,
            token=token,
            trace_id=trace_id,
            correlation_id=correlation_id,
        )
        if hasattr(client, "trace_id"):
            client.trace_id = trace_id
        if hasattr(client, "correlation_id"):
            client.correlation_id = correlation_id

        access_res = await client.check_user_access(sub=user_id, jti=jti)
        if not access_res or not access_res.get("allowed"):
            raise HTTPException(
                status_code=401,
                detail="User account inactive or token revoked",
            )

        return AuthenticatedUser(
            user_id=user_id,
            token=token,
            trace_id=trace_id,
            correlation_id=correlation_id,
            jti=jti,
        )
