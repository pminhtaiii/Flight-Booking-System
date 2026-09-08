import json
import logging
import re
from typing import Any, AsyncIterator, Dict, List, Optional, Protocol

import httpx
import jwt
from jwt import InvalidTokenError

from agent.auth.claim_token import create_claim_token
from agent.config import get_settings
from agent.observability.chat_observability import safe_opaque_id

logger = logging.getLogger(__name__)

MAX_UPSTREAM_BODY_BYTES = 65_536
MAX_UPSTREAM_JSON_DEPTH = 5
MAX_UPSTREAM_JSON_NODES = 5_000

_JSON_NUMBER = re.compile(r"-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?")


class UpstreamBodyLimitError(ValueError):
    """Raised when an upstream response cannot be safely loaded into memory."""


class _BoundedResponse(Protocol):
    headers: Any

    def aiter_bytes(self) -> AsyncIterator[bytes]: ...


def _scan_json_string(source: str, index: int) -> int | None:
    if source[index] != '"':
        return None
    index += 1
    while index < len(source):
        character = source[index]
        if character == '"':
            return index + 1
        if ord(character) < 0x20:
            return None
        if character == "\\":
            index += 1
            if index >= len(source):
                return None
            escape = source[index]
            if escape == "u":
                if index + 4 >= len(source) or any(
                    digit not in "0123456789abcdefABCDEF" for digit in source[index + 1 : index + 5]
                ):
                    return None
                index += 4
            elif escape not in '"\\/bfnrt':
                return None
        index += 1
    return None


def _raw_json_structure_is_within_limits(
    body: bytes,
    max_depth: int = MAX_UPSTREAM_JSON_DEPTH,
    max_nodes: int = MAX_UPSTREAM_JSON_NODES,
) -> bool:
    """Parse JSON delimiters iteratively before the recursive decoder sees the body."""
    try:
        source = body.decode("utf-8")
    except UnicodeDecodeError:
        return False

    stack: list[dict[str, str]] = []
    node_count = 0
    root_seen = False
    index = 0

    def begin_value() -> bool:
        nonlocal root_seen, node_count
        if not stack:
            if root_seen:
                return False
            root_seen = True
            return True
        frame = stack[-1]
        if frame["kind"] == "object" and frame["state"] == "value":
            frame["state"] = "separator"
            return True
        if frame["kind"] == "array" and frame["state"] in {"value_or_end", "value"}:
            node_count += 1
            if node_count > max_nodes:
                return False
            frame["state"] = "separator"
            return True
        return False

    while index < len(source):
        if source[index] in " \t\r\n":
            index += 1
            continue
        character = source[index]
        if stack and stack[-1]["kind"] == "object":
            frame = stack[-1]
            if frame["state"] in {"key_or_end", "key"}:
                if character == "}" and frame["state"] == "key_or_end":
                    stack.pop()
                    index += 1
                    continue
                string_end = _scan_json_string(source, index)
                if string_end is None:
                    return False
                node_count += 1
                if node_count > max_nodes:
                    return False
                frame["state"] = "colon"
                index = string_end
                continue
            if frame["state"] == "colon":
                if character != ":":
                    return False
                frame["state"] = "value"
                index += 1
                continue
            if frame["state"] == "separator":
                if character == "}":
                    stack.pop()
                    index += 1
                    continue
                if character != ",":
                    return False
                frame["state"] = "key"
                index += 1
                continue
        elif stack and stack[-1]["kind"] == "array":
            frame = stack[-1]
            if frame["state"] == "value_or_end" and character == "]":
                stack.pop()
                index += 1
                continue
            if frame["state"] == "separator":
                if character == "]":
                    stack.pop()
                    index += 1
                    continue
                if character != ",":
                    return False
                frame["state"] = "value"
                index += 1
                continue
        if character in "}]":
            return False
        if not begin_value():
            return False
        if character == "{":
            if len(stack) + 1 > max_depth:
                return False
            stack.append({"kind": "object", "state": "key_or_end"})
            index += 1
            continue
        if character == "[":
            if len(stack) + 1 > max_depth:
                return False
            stack.append({"kind": "array", "state": "value_or_end"})
            index += 1
            continue
        if character == '"':
            string_end = _scan_json_string(source, index)
            if string_end is None:
                return False
            index = string_end
            continue
        if source.startswith(("true", "false", "null"), index):
            index += (
                4 if source.startswith("true", index) or source.startswith("null", index) else 5
            )
            continue
        number = _JSON_NUMBER.match(source, index)
        if number is None:
            return False
        index = number.end()

    return root_seen and not stack


async def read_bounded_json(
    response: _BoundedResponse,
    max_bytes: int = MAX_UPSTREAM_BODY_BYTES,
    max_depth: int = MAX_UPSTREAM_JSON_DEPTH,
    max_nodes: int = MAX_UPSTREAM_JSON_NODES,
) -> Any:
    """Read decompressed response bytes within a fixed bound before JSON decoding."""
    content_length = response.headers.get("content-length")
    if content_length is not None:
        try:
            declared_size = int(content_length)
        except (TypeError, ValueError):
            declared_size = None
        if declared_size is not None and (declared_size < 0 or declared_size > max_bytes):
            raise UpstreamBodyLimitError("Upstream response body exceeds the permitted size")

    chunks: list[bytes] = []
    total = 0
    async for chunk in response.aiter_bytes():
        total += len(chunk)
        if total > max_bytes:
            raise UpstreamBodyLimitError("Upstream response body exceeds the permitted size")
        chunks.append(chunk)

    body = b"".join(chunks)
    if not _raw_json_structure_is_within_limits(body, max_depth=max_depth, max_nodes=max_nodes):
        raise UpstreamBodyLimitError("Upstream response body exceeds structural limits")

    try:
        return json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError("Upstream response body is not valid JSON") from exc


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
        if not isinstance(passenger, dict):
            return None
        p_keys = set(passenger.keys())
        has_issues = "issues" in p_keys
        has_sections = "sections" in p_keys
        if not (has_issues or has_sections):
            return None
        expected_keys = {"passengerType", "passengerOrdinal"}
        if has_issues:
            expected_keys.add("issues")
        if has_sections:
            expected_keys.add("sections")
        if p_keys != expected_keys:
            return None

        if passenger["passengerType"] not in _PASSENGER_TYPES or not _is_positive_int(
            passenger["passengerOrdinal"]
        ):
            return None

        safe_issues: list[dict] = []
        safe_sections: list[dict] = []

        if has_issues:
            if not isinstance(passenger["issues"], list):
                return None
            for issue in passenger["issues"]:
                if not _has_exact_keys(issue, {"section", "name", "status", "reason"}):
                    return None
                if (
                    issue["section"] not in _READINESS_SECTION_NAMES
                    or issue["name"] not in _READINESS_FIELD_NAMES
                    or issue["status"] not in _READINESS_STATUSES
                    or (issue["reason"] is not None and issue["reason"] not in _READINESS_REASONS)
                ):
                    return None
                safe_issues.append(
                    {
                        "section": issue["section"],
                        "name": issue["name"],
                        "status": issue["status"],
                        "reason": issue["reason"],
                    }
                )
            sections_map: dict[str, list[dict]] = {}
            for issue in safe_issues:
                sec_name = issue["section"]
                if sec_name not in sections_map:
                    sections_map[sec_name] = []
                sections_map[sec_name].append(
                    {
                        "name": issue["name"],
                        "status": issue["status"],
                        "reason": issue["reason"],
                    }
                )
            safe_sections = [
                {"name": sec_name, "fields": fields} for sec_name, fields in sections_map.items()
            ]
        elif has_sections:
            if not isinstance(passenger["sections"], list):
                return None
            for section in passenger["sections"]:
                if not _has_exact_keys(section, {"name", "fields"}):
                    return None
                if section["name"] not in _READINESS_SECTION_NAMES or not isinstance(
                    section["fields"], list
                ):
                    return None

                safe_fields = []
                for field in section["fields"]:
                    if not _has_exact_keys(field, {"name", "status", "reason"}):
                        return None
                    if (
                        field["name"] not in _READINESS_FIELD_NAMES
                        or field["status"] not in _READINESS_STATUSES
                        or (
                            field["reason"] is not None
                            and field["reason"] not in _READINESS_REASONS
                        )
                    ):
                        return None
                    safe_fields.append(
                        {
                            "name": field["name"],
                            "status": field["status"],
                            "reason": field["reason"],
                        }
                    )
                    safe_issues.append(
                        {
                            "section": section["name"],
                            "name": field["name"],
                            "status": field["status"],
                            "reason": field["reason"],
                        }
                    )

                safe_sections.append({"name": section["name"], "fields": safe_fields})

        safe_passengers.append(
            {
                "passengerType": passenger["passengerType"],
                "passengerOrdinal": passenger["passengerOrdinal"],
                "issues": safe_issues,
                "sections": safe_sections,
            }
        )

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

    async def check_user_access(
        self, sub: str, jti: Optional[str] = None, exp: Optional[int] = None
    ) -> Dict[str, Any]:
        """
        Calls service-authenticated NestJS access check POST /api/agent-gateway/chat/access/check.
        """
        settings = get_settings()
        url = f"{self.base_url}/agent-gateway/chat/access/check"
        claim_secret = getattr(settings, "primary_claim_token_secret", settings.CLAIM_TOKEN_SECRET)
        claim_token = create_claim_token(sub, claim_secret)
        headers = {
            "X-Agent-API-Key": settings.AGENT_SERVICE_API_KEY,
            "X-User-Claim": claim_token,
            "Content-Type": "application/json",
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
        self, session_id: str, sender: str, message_type: str, content: str
    ) -> Dict[str, Any]:
        if message_type == "SUMMARY":
            url = f"{self.base_url}/agent-gateway/chat/sessions/{session_id}/summaries"
            payload = {"content": content}
        else:
            url = f"{self.base_url}/agent-gateway/chat/sessions/{session_id}/messages"
            payload = {"sender": sender, "type": message_type, "content": content}
        headers = self._get_gateway_headers()
        async with httpx.AsyncClient() as client:
            response = await client.post(url, json=payload, headers=headers)
            response.raise_for_status()
            return response.json()

    async def create_message_batch(
        self, session_id: str, messages: List[Dict[str, Any]]
    ) -> Dict[str, Any]:
        url = f"{self.base_url}/agent-gateway/chat/sessions/{session_id}/turns"
        headers = self._get_gateway_headers()

        payload = {"messages": []}
        for msg in messages:
            payload["messages"].append(
                {
                    "sender": msg.get("sender", "USER"),
                    "type": msg.get("type", "STANDARD"),
                    "content": msg.get("content", ""),
                }
            )

        async with httpx.AsyncClient() as client:
            res = await client.post(url, json=payload, headers=headers)
            res.raise_for_status()
            return res.json()

    async def get_memory(
        self, session_id: str, recent_count: int = 20, unsummarized_only: bool = False
    ) -> Dict[str, Any]:
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
                decode_kwargs["issuer"] = getattr(settings, "JWT_ISSUER", "booking-systems-api")

            secrets = getattr(settings, "jwt_secret_ring", [settings.JWT_SECRET])
            payload = None
            for sec in secrets:
                try:
                    payload = jwt.decode(
                        self.token,
                        sec,
                        algorithms=["HS256"],
                        options=decode_options,
                        **decode_kwargs,
                    )
                    break
                except InvalidTokenError:
                    continue

            if not payload:
                raise InvalidTokenError("Failed to decode token with any configured secret")

            user_id = payload.get("id") or payload.get("sub")
            if not user_id:
                raise ValueError("Token is missing user identification claims ('id' or 'sub')")
        except InvalidTokenError as exc:
            if isinstance(self.token, str) and not self.token.startswith("ey"):
                user_id = self.token
            else:
                raise ValueError("Invalid authentication token") from exc

        claim_secret = getattr(settings, "primary_claim_token_secret", settings.CLAIM_TOKEN_SECRET)
        claim_token = create_claim_token(str(user_id), claim_secret)
        headers = {"X-Agent-API-Key": settings.AGENT_SERVICE_API_KEY, "X-User-Claim": claim_token}
        if self.correlation_id:
            headers["X-Correlation-ID"] = self.correlation_id
        if self.trace_id:
            headers["X-Trace-ID"] = self.trace_id
        if self.fencing_token is not None:
            headers["X-Fencing-Token"] = str(self.fencing_token)
        return headers

    async def get_gateway_flights_search(
        self, origin: str, destination: str, date: str, passengers: int
    ) -> dict:
        url = f"{self.base_url}/agent-gateway/flights/search"
        params = {
            "origin": origin,
            "destination": destination,
            "date": date,
            "passengers": passengers,
        }
        headers = self._get_gateway_headers()
        async with httpx.AsyncClient() as client:
            async with client.stream("GET", url, params=params, headers=headers) as response:
                if response.status_code == 400:
                    try:
                        data = await read_bounded_json(response)
                        message = data.get("message")
                        if message:
                            return {"error": message}
                    except (UpstreamBodyLimitError, ValueError):
                        logger.warning("flights_search_error_response_unparseable")
                response.raise_for_status()
                return await read_bounded_json(response)

    async def post_gateway_flights_search_v2(
        self,
        chat_session_id: str,
        proposed_snapshot_version: int,
        origin: str,
        destination: str,
        date: str,
        passengers: int,
    ) -> dict:
        url = f"{self.base_url}/agent-gateway/v2/flights/search"
        payload = {
            "chatSessionId": chat_session_id,
            "proposedSnapshotVersion": proposed_snapshot_version,
            "search": {
                "origin": origin,
                "destination": destination,
                "date": date,
                "adults": passengers,
            },
        }
        headers = self._get_gateway_headers()
        async with httpx.AsyncClient() as client:
            async with client.stream("POST", url, json=payload, headers=headers) as response:
                if response.status_code == 400:
                    try:
                        data = await read_bounded_json(response)
                        message = data.get("message")
                        if message:
                            if isinstance(message, list):
                                return {"error": ", ".join(message)}
                            return {"error": str(message)}
                    except (UpstreamBodyLimitError, ValueError):
                        logger.warning("flights_search_v2_error_response_unparseable")
                response.raise_for_status()
                return await read_bounded_json(response, max_depth=7)

    async def search_flights_v2(
        self,
        chat_session_id: str,
        proposed_snapshot_version: int,
        origin: str,
        destination: str,
        date: str,
        passengers: int,
    ) -> dict:
        return await self.post_gateway_flights_search_v2(
            chat_session_id=chat_session_id,
            proposed_snapshot_version=proposed_snapshot_version,
            origin=origin,
            destination=destination,
            date=date,
            passengers=passengers,
        )

    async def get_gateway_user_preferences(self) -> dict:
        url = f"{self.base_url}/agent-gateway/users/preferences"
        headers = self._get_gateway_headers()
        async with httpx.AsyncClient() as client:
            async with client.stream("GET", url, headers=headers) as response:
                response.raise_for_status()
                return await read_bounded_json(response)

    async def get_gateway_user_booking_summaries(self) -> dict:
        url = f"{self.base_url}/agent-gateway/users/bookings/summaries"
        headers = self._get_gateway_headers()
        async with httpx.AsyncClient() as client:
            async with client.stream("GET", url, headers=headers) as response:
                response.raise_for_status()
                return await read_bounded_json(response)

    async def get_gateway_booking_detail(self, booking_reference: str) -> dict:
        if (
            not booking_reference
            or not isinstance(booking_reference, str)
            or not booking_reference.startswith("bkref_")
        ):
            raise ValueError("Invalid booking reference format. Must start with 'bkref_'")
        url = f"{self.base_url}/agent-gateway/users/bookings/{booking_reference}"
        headers = self._get_gateway_headers()
        async with httpx.AsyncClient() as client:
            async with client.stream("GET", url, headers=headers) as response:
                if response.status_code == 404:
                    return {"error": "BOOKING_REFERENCE_NOT_FOUND", "statusCode": 404}
                response.raise_for_status()
                return await read_bounded_json(response)

    async def check_booking_readiness(
        self, flight_offer_id: str, passengers: List[Dict[str, Any]]
    ) -> dict:
        url = f"{self.base_url}/agent-gateway/bookings/readiness"
        headers = self._get_gateway_headers()

        # Validate that no unexpected keys or PII are passed in passengers
        safe_passengers = []
        allowed_keys = {"passengerType", "passengerOrdinal", "sourceType"}

        for p in passengers:
            if not set(p.keys()).issubset(allowed_keys):
                raise ValueError(
                    "Passenger dict contains invalid keys. Only passengerType, passengerOrdinal, and sourceType are allowed."
                )
            safe_passengers.append(
                {
                    "passengerType": p.get("passengerType"),
                    "passengerOrdinal": p.get("passengerOrdinal"),
                    "sourceType": p.get("sourceType"),
                }
            )

        payload = {"flightOfferId": flight_offer_id, "passengers": safe_passengers}

        async with httpx.AsyncClient() as client:
            async with client.stream("POST", url, json=payload, headers=headers) as response:
                if response.status_code != 200 and response.status_code != 201:
                    return {"error": "Booking readiness could not be verified safely."}

                try:
                    body = await read_bounded_json(response)
                except (UpstreamBodyLimitError, ValueError):
                    return {"error": "Received malformed readiness response from server."}
                safe_response = validate_booking_readiness_response(body)
                if safe_response is None:
                    return {"error": "Received malformed readiness response from server."}

                return safe_response

    async def create_handoff_token(
        self,
        attestation: str,
        selected_offer_index: int,
        trace_id: Optional[str] = None,
        correlation_id: Optional[str] = None,
        fingerprint: Optional[str] = None,
    ) -> dict:
        url = f"{self.base_url}/chat-handoff"
        headers = self._get_gateway_headers()
        if trace_id is not None:
            headers["X-Trace-ID"] = safe_opaque_id(trace_id)
        if correlation_id is not None:
            headers["X-Correlation-ID"] = safe_opaque_id(correlation_id)

        payload: dict[str, Any] = {
            "selectionAttestationHash": attestation,
            "selectedOfferIndex": selected_offer_index,
        }

        async with httpx.AsyncClient() as client:
            response = await client.post(url, json=payload, headers=headers)
            response.raise_for_status()
            body = response.json()
            return {
                "handoffToken": body.get("token") or body.get("handoffToken"),
                "expiresAt": body.get("expiresAt"),
                "display": body.get("display"),
            }

    async def create_handoff(
        self,
        attestation: str,
        offer_index: int,
        fingerprint: Optional[str] = None,
        trace_id: Optional[str] = None,
        correlation_id: Optional[str] = None,
        **kwargs: Any,
    ) -> dict:
        return await self.create_handoff_token(
            attestation=attestation,
            selected_offer_index=offer_index,
            trace_id=trace_id,
            correlation_id=correlation_id,
            fingerprint=fingerprint,
        )
