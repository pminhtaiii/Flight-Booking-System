import jwt
from typing import Dict, Any

def decode_and_verify_jwt(token: str, secret: str, issuer: str, audience: str) -> Dict[str, Any]:
    """
    Decode and verify a JWT token using the provided secret, issuer, and audience.
    Ensures that 'sub' (or 'id') and 'jti' claims are present.
    Returns the decoded payload.
    Raises jwt.ExpiredSignatureError, jwt.InvalidTokenError, or ValueError if claims are missing.
    """
    payload = jwt.decode(
        token,
        secret,
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
