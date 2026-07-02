import base64
import hashlib
import hmac
import json
import time

def create_claim_token(user_id: str, secret: str, iat: int = None) -> str:
    """
    Generates a claim token for the given user_id signed with the HMAC-SHA256 secret.
    The format of the returned token is {payload_b64url}.{signature_b64url} without padding.
    """
    if iat is None:
        iat = int(time.time())
    
    payload = {"userId": user_id, "iat": iat}
    payload_json = json.dumps(payload, separators=(',', ':'))
    payload_bytes = payload_json.encode('utf-8')
    
    payload_b64 = base64.urlsafe_b64encode(payload_bytes).decode('utf-8').rstrip('=')
    
    # Compute HMAC-SHA256 of the JSON string using secret
    secret_bytes = secret.encode('utf-8')
    signature_bytes = hmac.new(secret_bytes, payload_bytes, hashlib.sha256).digest()
    sig_b64 = base64.urlsafe_b64encode(signature_bytes).decode('utf-8').rstrip('=')
    
    return f"{payload_b64}.{sig_b64}"
