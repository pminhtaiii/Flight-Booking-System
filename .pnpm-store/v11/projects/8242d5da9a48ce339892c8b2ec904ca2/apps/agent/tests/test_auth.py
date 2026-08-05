import time
import jwt
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient
from agent.middleware.auth import JWTAuthMiddleware
from agent.middleware.rate_limit import RateLimitMiddleware

# Create a mock FastAPI app for testing
app = FastAPI()
app.add_middleware(JWTAuthMiddleware, secret="testsecret", exclude_paths=["/health", "/public"])

@app.get("/health")
def health():
    return {"status": "ok"}

@app.get("/public")
def public_route():
    return {"message": "hello public"}

@app.get("/protected")
def protected_route(request: Request):
    return {"user": request.state.user}

client = TestClient(app)

def test_public_routes():
    # Public routes should pass without any auth headers
    response = client.get("/health")
    assert response.status_code == 200
    
    response = client.get("/public")
    assert response.status_code == 200

def test_protected_missing_header():
    response = client.get("/protected")
    assert response.status_code == 401
    assert response.json()["detail"] == "Missing authorization header"

def test_protected_invalid_format():
    response = client.get("/protected", headers={"Authorization": "InvalidFormatToken"})
    assert response.status_code == 401
    assert response.json()["detail"] == "Invalid authorization header format"

def test_protected_invalid_token():
    response = client.get("/protected", headers={"Authorization": "Bearer invalid.token.here"})
    assert response.status_code == 401
    assert response.json()["detail"] == "Invalid token"

def test_protected_expired_token():
    payload = {"sub": "12345", "email": "test@example.com", "exp": int(time.time()) - 10}
    token = jwt.encode(payload, "testsecret", algorithm="HS256")
    response = client.get("/protected", headers={"Authorization": f"Bearer {token}"})
    assert response.status_code == 401
    assert response.json()["detail"] == "Token has expired"

def test_protected_valid_token():
    payload = {"sub": "12345", "email": "test@example.com", "exp": int(time.time()) + 100}
    token = jwt.encode(payload, "testsecret", algorithm="HS256")
    response = client.get("/protected", headers={"Authorization": f"Bearer {token}"})
    assert response.status_code == 200
    assert response.json()["user"] == {"sub": "12345", "email": "test@example.com", "exp": payload["exp"]}


app_limiter = FastAPI()
app_limiter.add_middleware(RateLimitMiddleware, limit=2, window=10)

@app_limiter.get("/health")
def health_limiter():
    return {"status": "ok"}

@app_limiter.get("/test")
def route_limiter():
    return {"status": "ok"}


client_limiter = TestClient(app_limiter)

def test_rate_limiting():
    # Health check is exempt
    for _ in range(5):
        response = client_limiter.get("/health")
        assert response.status_code == 200

    # Test rate limiter limit of 2 requests
    response = client_limiter.get("/test")
    assert response.status_code == 200

    response = client_limiter.get("/test")
    assert response.status_code == 200

    response = client_limiter.get("/test")
    assert response.status_code == 429
    assert response.json()["detail"] == "Too many requests. Please try again later."

