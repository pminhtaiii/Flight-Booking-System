import jwt
from typing import Dict, Any, Union, Sequence

def decode_and_verify_jwt(
    token: str,
    secret: Union[str, Sequence[str]],
    issuer: str,
    audience: str
) -> Dict[str, Any]:
    """
    Decode and verify a JWT token using the provided secret or candidate secrets, issuer, and audience.
    Ensures that 'sub' (or 'id') and 'jti' claims are present.
    Returns the decoded payload.
    Raises jwt.ExpiredSignatureError, jwt.InvalidTokenError, or ValueError if verification fails.
    """
    candidate_secrets = [secret] if isinstance(secret, str) else list(secret)
    candidate_secrets = [s for s in candidate_secrets if isinstance(s, str) and s.strip()]
    if not candidate_secrets:
        raise ValueError("No valid JWT secrets provided for verification")

    last_error: Exception = jwt.InvalidTokenError("Invalid token")
    for sec in candidate_secrets:
        try:
            payload = jwt.decode(
                token,
                sec,
                algorithms=["HS256"],
                issuer=issuer,
                audience=audience,
                options={"verify_iss": True, "verify_aud": True},
            )
            sub = payload.get("sub") or payload.get("id")
            jti = payload.get("jti")
            if not sub or not jti:
                raise ValueError("Invalid token: missing sub or jti claim")
            return payload
        except jwt.ExpiredSignatureError as e:
            # If expired under a validly signed candidate key, immediately raise expired
            last_error = e
            raise
        except (jwt.InvalidTokenError, ValueError) as e:
            last_error = e
            continue

    raise last_error

