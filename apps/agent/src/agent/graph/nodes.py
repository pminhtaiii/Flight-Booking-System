import json
import logging
from datetime import datetime, timedelta, timezone
from typing import Any

from langchain_core.messages import HumanMessage, SystemMessage
from langchain_core.runnables import RunnableConfig
from langgraph.prebuilt import ToolNode

from agent.agents.chat_agent import get_chat_model
from agent.agents.travel_assistant import TRAVEL_PROMPT
from agent.config import get_settings
from agent.graph.state import AgentState
from agent.tools.base import get_nestjs_client
from agent.tools.registry import get_tools
from agent.trusted_search_snapshot import (
    ResolvedOfferSelection,
    TrustedSearchResult,
    TrustedSearchSnapshot,
    TrustedSearchSnapshotLifecycle,
)

logger = logging.getLogger("agent.graph.nodes")


async def final_answer_node(state: AgentState, config: RunnableConfig) -> dict:
    """Call the LLM without tools bound to provide a final summary answer when iteration limit is reached."""
    model = get_chat_model()

    messages = list(state.get("messages", []))
    has_system = any(isinstance(m, SystemMessage) for m in messages)
    if not has_system:
        messages.insert(0, SystemMessage(content=TRAVEL_PROMPT))

    instruction = (
        "\n[System Note: The tool calling limit has been reached. Please provide a final response summarizing "
        "what you have found so far, or politely state that you cannot complete the operation or retrieve "
        "further information at this time.]"
    )
    messages.append(HumanMessage(content=instruction))

    response = await model.ainvoke(messages, config=config)
    return {"messages": [response]}


# Create the prebuilt ToolNode
prebuilt_tool_node = ToolNode(get_tools())


async def custom_tool_node(state: AgentState, config: RunnableConfig) -> dict:
    """Execute prebuilt ToolNode, parse signals from tool messages, and increment iteration count."""
    result = await prebuilt_tool_node.ainvoke(state, config=config)
    current_iter = state.get("iteration_count") or 0

    update_dict = {"iteration_count": current_iter + 1}

    if isinstance(result, dict) and "messages" in result:
        messages = result["messages"]
        update_dict["messages"] = messages

        # Parse signal from ToolMessage if present
        for msg in messages:
            if hasattr(msg, "content") and isinstance(msg.content, str):
                try:
                    data = json.loads(msg.content)
                    if isinstance(data, dict) and "signal" in data:
                        update_dict["signal"] = data["signal"]
                        # Mask the content so the LLM sees a natural response
                        msg.content = "Checkout intent registered successfully."
                except json.JSONDecodeError:
                    logger.debug("non_json_tool_message_ignored")
    elif isinstance(result, list):
        update_dict["messages"] = result
    else:
        # Fallback if ToolNode returns something else
        update_dict.update(result)

    return update_dict


_ALLOWLISTED_DISPLAY_FIELDS = (
    "airline",
    "origin",
    "destination",
    "departureAt",
    "arrivalAt",
    "price",
    "currency",
)


def _to_utc_datetime(val: Any) -> datetime:
    if isinstance(val, datetime):
        if val.tzinfo is None:
            return val.replace(tzinfo=timezone.utc)
        return val.astimezone(timezone.utc)
    if not val or not isinstance(val, str):
        raise ValueError(f"Invalid datetime value: {val}")
    dt = datetime.fromisoformat(val.strip().replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _extract_display_info(
    offer: TrustedSearchResult | None = None,
    upstream_display: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    """Extract allowlisted display fields from offer and upstream response."""
    display_info: dict[str, Any] = {}

    if offer is not None:
        for field in _ALLOWLISTED_DISPLAY_FIELDS:
            val = getattr(offer, field, None)
            if val is not None:
                if isinstance(val, datetime):
                    if val.tzinfo == timezone.utc or val.utcoffset() == timedelta(0):
                        display_info[field] = val.strftime("%Y-%m-%dT%H:%M:%SZ")
                    else:
                        display_info[field] = val.isoformat()
                elif field == "price":
                    display_info[field] = str(val)
                else:
                    display_info[field] = val

    if isinstance(upstream_display, dict):
        for field in _ALLOWLISTED_DISPLAY_FIELDS:
            if field in upstream_display:
                val = upstream_display[field]
                if isinstance(val, datetime):
                    if val.tzinfo == timezone.utc or val.utcoffset() == timedelta(0):
                        display_info[field] = val.strftime("%Y-%m-%dT%H:%M:%SZ")
                    else:
                        display_info[field] = val.isoformat()
                elif field == "price":
                    display_info[field] = str(val)
                else:
                    display_info[field] = val

    return display_info if display_info else None


async def validate_handoff(state: AgentState, config: RunnableConfig) -> dict:
    """Validate snapshot and signal before creating handoff."""
    norm_state = TrustedSearchSnapshotLifecycle.normalize_graph_state(dict(state) if state else {})
    signal = norm_state.get("signal")
    if not signal or not isinstance(signal, dict):
        logger.info("validate_handoff_missing_signal")
        return {"action": {"error": "Missing checkout signal."}}

    offer_index = (
        signal.get("offer_index")
        if signal.get("offer_index") is not None
        else signal.get("selected_index")
    )
    if (
        offer_index is None
        or isinstance(offer_index, bool)
        or not isinstance(offer_index, int)
        or offer_index < 1
    ):
        logger.info("validate_handoff_invalid_offer_index")
        return {"action": {"error": "Missing checkout signal."}}

    snapshot = norm_state.get("trusted_snapshot")
    if hasattr(snapshot, "model_dump"):
        snapshot = snapshot.model_dump(mode="json")

    if not snapshot or not isinstance(snapshot, dict):
        logger.info("validate_handoff_missing_snapshot")
        return {"action": {"error": "Missing or invalid trusted snapshot."}}

    version = (
        snapshot.get("snapshotVersion")
        if snapshot.get("snapshotVersion") is not None
        else snapshot.get("version")
    )
    if version is None or isinstance(version, bool) or not isinstance(version, int) or version < 1:
        logger.info("validate_handoff_invalid_snapshot_version")
        return {"action": {"error": "Missing or invalid trusted snapshot."}}

    attestation = snapshot.get("selectionAttestation") or snapshot.get("attestation")
    if not attestation or not isinstance(attestation, str) or not attestation.strip():
        logger.info("validate_handoff_invalid_snapshot_attestation")
        return {"action": {"error": "Missing or invalid trusted snapshot."}}

    results = (
        snapshot.get("results") if snapshot.get("results") is not None else snapshot.get("offers")
    )
    if not isinstance(results, list) or len(results) == 0:
        logger.info("validate_handoff_missing_results")
        return {"action": {"error": "Missing or invalid search results in snapshot."}}

    if not (1 <= offer_index <= len(results)):
        logger.info("validate_handoff_offer_index_out_of_bounds")
        return {"action": {"error": "Selected offer index is out of bounds."}}

    expires_at_raw = snapshot.get("expiresAt") or snapshot.get("snapshotExpiresAt")
    if expires_at_raw:
        try:
            if isinstance(expires_at_raw, datetime):
                expires_dt = expires_at_raw
            elif isinstance(expires_at_raw, str):
                expires_dt = datetime.fromisoformat(expires_at_raw.replace("Z", "+00:00"))
            else:
                expires_dt = None

            if expires_dt:
                if expires_dt.tzinfo is None:
                    expires_dt = expires_dt.replace(tzinfo=timezone.utc)
                if expires_dt <= datetime.now(timezone.utc):
                    logger.info("validate_handoff_snapshot_expired")
                    return {
                        "action": {"error": "Search snapshot has expired. Please search again."}
                    }
        except (ValueError, TypeError):
            logger.info("validate_handoff_snapshot_expiry_parse_error")
            return {"action": {"error": "Search snapshot has expired. Please search again."}}

    return {}


async def create_handoff_token(state: AgentState, config: RunnableConfig) -> dict:
    """Create a handoff token using NestJSClient and emit action."""
    if not get_settings().FEATURE_FLAG_CHAT_HANDOFF_ISSUE:
        logger.info("create_handoff_token_disabled")
        return {"action": {"error": "Chat handoff issuance is disabled."}}

    norm_state = TrustedSearchSnapshotLifecycle.normalize_graph_state(dict(state) if state else {})
    signal = norm_state.get("signal")
    snapshot_raw = norm_state.get("trusted_snapshot")

    if (
        not signal
        or not isinstance(signal, dict)
        or snapshot_raw is None
        or (
            not isinstance(snapshot_raw, dict)
            and not isinstance(snapshot_raw, TrustedSearchSnapshot)
        )
    ):
        logger.info("create_handoff_token_invalid_state")
        return {"action": {"error": "Invalid state for handoff creation."}}

    offer_index = (
        signal.get("offer_index")
        if signal.get("offer_index") is not None
        else signal.get("selected_index")
    )
    if (
        offer_index is None
        or isinstance(offer_index, bool)
        or not isinstance(offer_index, int)
        or offer_index < 1
    ):
        logger.info("create_handoff_token_invalid_offer_index")
        return {"action": {"error": "Invalid state for handoff creation."}}

    try:
        if isinstance(snapshot_raw, TrustedSearchSnapshot):
            snapshot_obj = snapshot_raw
        else:
            raw_results = snapshot_raw.get("results") or snapshot_raw.get("offers")
            if not isinstance(raw_results, list) or len(raw_results) == 0:
                logger.info("create_handoff_token_missing_results")
                return {"action": {"error": "Invalid state for handoff creation."}}

            results_list: list[TrustedSearchResult] = []
            for i, item in enumerate(raw_results, 1):
                if isinstance(item, TrustedSearchResult):
                    results_list.append(item)
                elif isinstance(item, dict):
                    flight_offer_id = item.get("flightOfferId")
                    duffel_offer_id = item.get("duffelOfferId") or flight_offer_id
                    if not flight_offer_id or not duffel_offer_id:
                        logger.info("create_handoff_token_missing_offer_ids")
                        return {"action": {"error": "Invalid state for handoff creation."}}

                    dep_val = item.get("departureAt") or item.get("departureTime")
                    arr_val = item.get("arrivalAt") or item.get("arrivalTime")
                    if not dep_val or not arr_val:
                        logger.info("create_handoff_token_missing_timestamps")
                        return {"action": {"error": "Invalid state for handoff creation."}}

                    dep_dt = _to_utc_datetime(dep_val)
                    arr_dt = _to_utc_datetime(arr_val)

                    results_list.append(
                        TrustedSearchResult(
                            offerIndex=item.get("offerIndex", i),
                            flightOfferId=str(flight_offer_id),
                            duffelOfferId=str(duffel_offer_id),
                            airline=str(item.get("airline") or ""),
                            origin=str(item.get("origin") or item.get("departureAirport") or ""),
                            destination=str(
                                item.get("destination") or item.get("arrivalAirport") or ""
                            ),
                            departureAt=dep_dt,
                            arrivalAt=arr_dt,
                            price=str(item.get("price", "0.0")),
                            currency=str(item.get("currency", "USD")),
                        )
                    )
                else:
                    logger.info("create_handoff_token_invalid_result_item")
                    return {"action": {"error": "Invalid state for handoff creation."}}

            created_at_raw = snapshot_raw.get("createdAt")
            created_at = (
                _to_utc_datetime(created_at_raw) if created_at_raw else datetime.now(timezone.utc)
            )

            expires_at_raw = snapshot_raw.get("expiresAt") or snapshot_raw.get("snapshotExpiresAt")
            if expires_at_raw:
                expires_at = _to_utc_datetime(expires_at_raw)
            else:
                expires_at = created_at + timedelta(minutes=15)

            attestation = snapshot_raw.get("selectionAttestation") or snapshot_raw.get(
                "attestation"
            )
            if not attestation or not isinstance(attestation, str) or not attestation.strip():
                logger.info("create_handoff_token_missing_attestation")
                return {"action": {"error": "Invalid state for handoff creation."}}

            fingerprint = snapshot_raw.get("fingerprint") or attestation
            if not fingerprint or not isinstance(fingerprint, str) or not fingerprint.strip():
                logger.info("create_handoff_token_missing_fingerprint")
                return {"action": {"error": "Invalid state for handoff creation."}}

            version = (
                snapshot_raw.get("snapshotVersion")
                if snapshot_raw.get("snapshotVersion") is not None
                else snapshot_raw.get("version")
            )
            if (
                version is None
                or isinstance(version, bool)
                or not isinstance(version, int)
                or version < 1
            ):
                version = 1

            snapshot_obj = TrustedSearchSnapshot(
                schemaVersion=snapshot_raw.get("schemaVersion", 1),
                snapshotVersion=version,
                userId=str(snapshot_raw.get("userId") or "user"),
                sessionId=str(snapshot_raw.get("sessionId") or "session"),
                createdAt=created_at,
                expiresAt=expires_at,
                fingerprint=fingerprint,
                selectionAttestation=attestation,
                results=results_list,
            )

        lifecycle = TrustedSearchSnapshotLifecycle(None)
        resolved_selection: ResolvedOfferSelection = await lifecycle.select(
            snapshot_obj, offer_index
        )

        client = get_nestjs_client(config)
        response = await client.create_handoff_token(
            attestation=resolved_selection.selection_attestation,
            selected_offer_index=resolved_selection.offer_index,
            fingerprint=snapshot_obj.fingerprint,
        )

        if not isinstance(response, dict) or "error" in response:
            logger.error("create_handoff_token_upstream_error")
            return {"action": {"error": "Checkout handoff could not be created."}}

        handoff_token = response.get("handoffToken") or response.get("token")
        expires_at_token = response.get("expiresAt")

        if not handoff_token:
            logger.error("create_handoff_token_missing_token")
            return {"action": {"error": "Checkout handoff could not be created."}}

        display_info = _extract_display_info(
            offer=resolved_selection.offer,
            upstream_display=response.get("display")
            if isinstance(response.get("display"), dict)
            else None,
        )

        return {
            "action": {
                "action": "begin_checkout",
                "handoffToken": handoff_token,
                "expiresAt": expires_at_token,
                "display": display_info,
            }
        }
    except Exception:
        logger.error("create_handoff_token_failed")
        return {"action": {"error": "Checkout handoff could not be created."}}


create_handoff_token_node = create_handoff_token
