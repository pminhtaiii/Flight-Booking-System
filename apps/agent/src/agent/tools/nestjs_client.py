import httpx
import jwt
from jwt import InvalidTokenError
from typing import Optional, List, Dict, Any
import logging
from agent.config import get_settings
from agent.auth.claim_token import create_claim_token
from agent.observability.chat_observability import safe_opaque_id

logger = logging.getLogger(__name__)

_READINESS_SCOPES = {"DOMESTIC", "INTERNATIONAL", "UNKNOWN"}
_READINESS_ACTIONS = {"COMPLETE_PROFILE", "CONTINUE_CHECKOUT"}
_PASSENGER_TYPES = {"ADULT", "CHILD", "INFANT"}
_READINESS_SECTION_NAMES = {
    "itinerary",
    "identity",
    "contact",
    "travel_document",
    "entry_eligibility",
}
_READINESS_FIELD_NAMES = {
    "scope",
    "destinationEntryEligibility",
    "givenName",
    "middleName",
    "familyName",
    "dateOfBirth",
    "gender",
    "title",
    "nationality",
    "email",
    "phoneCountryCode",
    "phoneNumber",
    "documentType",
    "passportNumber",
    "passportExpiry",
    "issuingCountry",
}
_READINESS_STATUSES = {"filled", "missing", "invalid", "warning", "unknown"}
_READINESS_REASONS = {
    "REQUIRED",
    "PASSPORT_VALIDITY_REQUIRES_VERIFICATION",
    "UNSUPPORTED_DOCUMENT_TYPE",
    "EXPIRED",
    "AIRPORT_COUNTRY_UNAVAILABLE",
    "PROFILE_CHANGED",
    "READINESS_DEPENDENCY_UNAVAILABLE",
    "ENTRY_ELIGIBILITY_UNKNOWN",
    "INVALID_COUNTRY",
    "INVALID_DATE",
    "INVALID_DOCUMENT_NUMBER",
    "INVALID_EMAIL",
    "INVALID_GENDER",
    "INVALID_PHONE",
    "INVALID_TITLE",
    "ITINERARY_UNAVAILABLE",
    "TRIP_COMPLETION_UNAVAILABLE",
}


def _has_exact_keys(value: object, expected: set[str]) -> bool:
    return isinstance(value, dict) and set(value.keys()) == expected


def _is_positive_int(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 1


def validate_booking_readiness_response(data: object) -> Optional[dict]:
    """Return a copied, PII-safe readiness result or ``None`` for malformed data."""
    if not _has_exact_keys(data, {"scope", "ready", "passengers", "nextAction"}):
        return None

    if (
        data["scope"] not in _READINESS_SCOPES
        or not isinstance(data["ready"], bool)
        or data["nextAction"] not in _READINESS_ACTIONS
        or not isinstance(data["passengers"], list)
    ):
        return None

    safe_passengers = []
    for passenger in data["passengers"]:
        if not _has_exact_keys(passenger, {"passengerType", "passengerOrdinal", "sections"}):
            return None
        if (
            passenger["passengerType"] not in _PASSENGER_TYPES
            or not _is_positive_int(passenger["passengerOrdinal"])
            or not isinstance(passenger["sections"], list)
        ):
            return None

        safe_sections = []
        for section in passenger["sections"]:
            if not _has_exact_keys(section, {"name", "fields"}):
                return None
            if section["name"] not in _READINESS_SECTION_NAMES or not isinstance(section["fields"], list):
                return None

            safe_fields = []
            for field in section["fields"]:
                if not _has_exact_keys(field, {"name", "status", "reason"}):
                    return None
                if (
                    field["name"] not in _READINESS_FIELD_NAMES
                    or field["status"] not in _READINESS_STATUSES
                    or (field["reason"] is not None and field["reason"] not in _READINESS_REASONS)
                ):
                    return None
                safe_fields.append({
                    "name": field["name"],
                    "status": field["status"],
                    "reason": field["reason"],
                })

            safe_sections.append({"name": section["name"], "fields": safe_fields})

        safe_passengers.append({
            "passengerType": passenger["passengerType"],
            "passengerOrdinal": passenger["passengerOrdinal"],
            "sections": safe_sections,
        })

    return {
        "scope": data["scope"],
        "ready": data["ready"],
        "passengers": safe_passengers,
        "nextAction": data["nextAction"],
    }

class NestJSClient:
    def __init__(
        self,
        base_url: str,
        token: str,
        trace_id: Optional[str] = None,
        correlation_id: Optional[str] = None,
        fencing_token: Optional[Any] = None,
    ):
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.headers = {"Authorization": f"Bearer {token}"}
        self.trace_id = safe_opaque_id(trace_id)
        self.correlation_id = safe_opaque_id(correlation_id)
        self.set_fencing_token(fencing_token)

    def set_fencing_token(self, fencing_token: Optional[Any]) -> None:
        self.fencing_token = fencing_token
        if fencing_token is not None:
            self.headers["X-Fencing-Token"] = str(fencing_token)
        else:
            self.headers.pop("X-Fencing-Token", None)

    async def check_user_access(self, sub: str, jti: Optional[str] = None, exp: Optional[int] = None) -> Dict[str, Any]:
        """
        Calls service-authenticated NestJS access check POST /api/agent-gateway/chat/access/check.
        """
        settings = get_settings()
        url = f"{self.base_url}/agent-gateway/chat/access/check"
        claim_token = create_claim_token(sub, settings.CLAIM_TOKEN_SECRET)
        headers = {
            "X-Agent-API-Key": settings.AGENT_SERVICE_API_KEY,
            "X-User-Claim": claim_token,
            "Content-Type": "application/json"
        }
        headers["X-Trace-Id"] = self.trace_id
        headers["X-Correlation-Id"] = self.correlation_id
        payload: Dict[str, Any] = {"sub": sub}
        if jti:
            payload["jti"] = jti
        if exp:
            payload["exp"] = exp

        async with httpx.AsyncClient() as client:
            try:
                response = await client.post(url, json=payload, headers=headers)
                if response.status_code == 200:
                    return response.json()
                return {"allowed": False}
            except Exception:
                logger.error("check_user_access_failed")
                return {"allowed": False}

    async def create_session(self, title: Optional[str] = None) -> Dict[str, Any]:
        url = f"{self.base_url}/agent-gateway/chat/sessions"
        payload = {"title": title}
        headers = self._get_gateway_headers()
        async with httpx.AsyncClient() as client:
            response = await client.post(url, json=payload, headers=headers)
            response.raise_for_status()
            return response.json()

    async def create_message(
        self,
        session_id: str,
        sender: str,
        message_type: str,
        content: str
    ) -> Dict[str, Any]:
        if message_type == "SUMMARY":
            url = f"{self.base_url}/agent-gateway/chat/sessions/{session_id}/summaries"
            payload = {"content": content}
        else:
            url = f"{self.base_url}/agent-gateway/chat/sessions/{session_id}/messages"
            payload = {
                "sender": sender,
                "type": message_type,
                "content": content
            }
        headers = self._get_gateway_headers()
        async with httpx.AsyncClient() as client:
            response = await client.post(url, json=payload, headers=headers)
            response.raise_for_status()
            return response.json()

    async def create_message_batch(
        self,
        session_id: str,
        messages: List[Dict[str, Any]]
    ) -> Dict[str, Any]:
        url = f"{self.base_url}/agent-gateway/chat/sessions/{session_id}/turns"
        headers = self._get_gateway_headers()
        
        payload = {"messages": []}
        for msg in messages:
            payload["messages"].append({
                "sender": msg.get("sender", "USER"),
                "type": msg.get("type", "STANDARD"),
                "content": msg.get("content", "")
            })
            
        async with httpx.AsyncClient() as client:
            res = await client.post(url, json=payload, headers=headers)
            res.raise_for_status()
            return res.json()

    async def get_memory(self, session_id: str, recent_count: int = 20, unsummarized_only: bool = False) -> Dict[str, Any]:
        url = f"{self.base_url}/agent-gateway/chat/sessions/{session_id}/memory"
        params = {"recentCount": recent_count}
        if unsummarized_only:
            params["unsummarizedOnly"] = "true"
        headers = self._get_gateway_headers()
        async with httpx.AsyncClient() as client:
            response = await client.get(url, params=params, headers=headers)
            response.raise_for_status()
            return response.json()

    def _get_gateway_headers(self) -> dict:
        settings = get_settings()
        try:
            unverified = jwt.decode(
                self.token,
                options={"verify_signature": False},
                algorithms=["HS256"],
            )
            decode_options = {"verify_aud": "aud" in unverified}
            decode_kwargs: dict[str, Any] = {}
            if "aud" in unverified:
                decode_kwargs["audience"] = getattr(
                    settings, "JWT_AUDIENCE", "booking-systems-clients"
                )
            if "iss" in unverified:
                decode_kwargs["issuer"] = getattr(
                    settings, "JWT_ISSUER", "booking-systems-api"
                )
            payload = jwt.decode(
                self.token,
                settings.JWT_SECRET,
                algorithms=["HS256"],
                options=decode_options,
                **decode_kwargs,
            )
            user_id = payload.get("id") or payload.get("sub")
            if not user_id:
                raise ValueError("Token is missing user identification claims ('id' or 'sub')")
        except InvalidTokenError as exc:
            if isinstance(self.token, str) and not self.token.startswith("ey"):
                user_id = self.token
            else:
                raise ValueError("Invalid authentication token") from exc

        claim_token = create_claim_token(str(user_id), settings.CLAIM_TOKEN_SECRET)
        headers = {
            "X-Agent-API-Key": settings.AGENT_SERVICE_API_KEY,
            "X-User-Claim": claim_token
        }
        if self.correlation_id:
            headers["X-Correlation-ID"] = self.correlation_id
        if self.trace_id:
            headers["X-Trace-ID"] = self.trace_id
        if self.fencing_token is not None:
            headers["X-Fencing-Token"] = str(self.fencing_token)
        return headers

    async def get_gateway_flights_search(self, origin: str, destination: str, date: str, passengers: int) -> dict:
        url = f"{self.base_url}/agent-gateway/flights/search"
        params = {
            "origin": origin,
            "destination": destination,
            "date": date,
            "passengers": passengers
        }
        headers = self._get_gateway_headers()
        async with httpx.AsyncClient() as client:
            response = await client.get(url, params=params, headers=headers)
            if response.status_code == 400:
                try:
                    data = response.json()
                    message = data.get("message")
                    if message:
                        return {"error": message}
                except ValueError:
                    logger.warning("flights_search_error_response_unparseable")
            response.raise_for_status()
            return response.json()

    async def post_gateway_flights_search_v2(self, chat_session_id: str, proposed_snapshot_version: int, origin: str, destination: str, date: str, passengers: int) -> dict:
        url = f"{self.base_url}/agent-gateway/v2/flights/search"
        payload = {
            "chatSessionId": chat_session_id,
            "proposedSnapshotVersion": proposed_snapshot_version,
            "search": {
                "origin": origin,
                "destination": destination,
                "date": date,
                "adults": passengers
            }
        }
        headers = self._get_gateway_headers()
        async with httpx.AsyncClient() as client:
            response = await client.post(url, json=payload, headers=headers)
            if response.status_code == 400:
                try:
                    data = response.json()
                    message = data.get("message")
                    if message:
                        return {"error": message}
                except ValueError:
                    logger.warning("flights_search_v2_error_response_unparseable")
            response.raise_for_status()
            return response.json()

    async def get_gateway_user_preferences(self) -> dict:
        url = f"{self.base_url}/agent-gateway/users/preferences"
        headers = self._get_gateway_headers()
        async with httpx.AsyncClient() as client:
            response = await client.get(url, headers=headers)
            response.raise_for_status()
            return response.json()

    async def get_gateway_user_booking_summaries(self) -> dict:
        url = f"{self.base_url}/agent-gateway/users/bookings"
        headers = self._get_gateway_headers()
        async with httpx.AsyncClient() as client:
            response = await client.get(url, headers=headers)
            response.raise_for_status()
            data = response.json()
            summaries = []
            for b in data.get("bookings", []):
                summaries.append({
                    "agentReference": b.get("id"),
                    "status": b.get("status"),
                    "airline": b.get("airline"),
                    "origin": b.get("origin"),
                    "destination": b.get("destination"),
                    "departureAt": b.get("departureTime"),
                    "arrivalAt": b.get("arrivalTime"),
                    "durationMinutes": b.get("duration"),
                    "stopCount": b.get("stops")
                })
            return {"summaries": summaries}

    async def get_gateway_booking_detail(self, agent_reference: str) -> dict:
        url = f"{self.base_url}/agent-gateway/users/bookings"
        headers = self._get_gateway_headers()
        async with httpx.AsyncClient() as client:
            response = await client.get(url, headers=headers)
            response.raise_for_status()
            data = response.json()
            for b in data.get("bookings", []):
                if b.get("id") == agent_reference:
                    return {
                        "status": b.get("status"),
                        "airline": b.get("airline"),
                        "origin": b.get("origin"),
                        "destination": b.get("destination"),
                        "departureAt": b.get("departureTime"),
                        "arrivalAt": b.get("arrivalTime"),
                        "flightNumber": b.get("flightNumber"),
                        "baggageSummary": b.get("baggageAllowance", "Not specified")
                    }
            return {"error": "Not Found", "statusCode": 404}

    async def check_booking_readiness(self, flight_offer_id: str, passengers: List[Dict[str, Any]]) -> dict:
        url = f"{self.base_url}/agent-gateway/bookings/readiness"
        headers = self._get_gateway_headers()

        # Validate that no unexpected keys or PII are passed in passengers
        safe_passengers = []
        allowed_keys = {"passengerType", "passengerOrdinal", "sourceType"}

        for p in passengers:
            if not set(p.keys()).issubset(allowed_keys):
                raise ValueError("Passenger dict contains invalid keys. Only passengerType, passengerOrdinal, and sourceType are allowed.")
            safe_passengers.append({
                "passengerType": p.get("passengerType"),
                "passengerOrdinal": p.get("passengerOrdinal"),
                "sourceType": p.get("sourceType")
            })

        payload = {
            "flightOfferId": flight_offer_id,
            "passengers": safe_passengers
        }

        async with httpx.AsyncClient() as client:
            response = await client.post(url, json=payload, headers=headers)

            if response.status_code != 200 and response.status_code != 201:
                return {"error": "Booking readiness could not be verified safely."}

            safe_response = validate_booking_readiness_response(response.json())
            if safe_response is None:
                return {"error": "Received malformed readiness response from server."}

            return safe_response

    async def create_handoff(self, attestation: str, offer_index: int, fingerprint: Optional[str] = None) -> dict:
        url = f"{self.base_url}/chat-handoff"
        headers = self._get_gateway_headers()
        payload: dict[str, Any] = {
            "selectionAttestationHash": attestation,
            "selectedOfferIndex": offer_index,
        }

        async with httpx.AsyncClient() as client:
            response = await client.post(url, json=payload, headers=headers)
            response.raise_for_status()
            body = response.json()
            return {
                "handoffToken": body["token"],
                "expiresAt": body["expiresAt"],
            }

