import json
import logging
from datetime import datetime, timezone

from langchain_core.messages import HumanMessage, SystemMessage
from langchain_core.runnables import RunnableConfig
from langgraph.prebuilt import ToolNode

from agent.agents.chat_agent import get_chat_model
from agent.agents.travel_assistant import TRAVEL_PROMPT
from agent.config import get_settings
from agent.graph.state import AgentState
from agent.tools.base import get_nestjs_client
from agent.tools.registry import get_tools

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


async def validate_handoff(state: AgentState, config: RunnableConfig) -> dict:
    """Validate snapshot and signal before creating handoff."""
    signal = state.get("signal")
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

    snapshot = state.get("trusted_snapshot") or state.get("snapshot")
    if hasattr(snapshot, "model_dump"):
        snapshot = snapshot.model_dump(mode="json")

    if not snapshot or not isinstance(snapshot, dict):
        logger.info("validate_handoff_missing_snapshot")
        return {"action": {"error": "Missing or invalid trusted snapshot."}}

    version = (
        snapshot.get("version")
        if snapshot.get("version") is not None
        else snapshot.get("snapshotVersion")
    )
    if version is None or isinstance(version, bool) or not isinstance(version, int) or version < 1:
        logger.info("validate_handoff_invalid_snapshot_version")
        return {"action": {"error": "Missing or invalid trusted snapshot."}}

    attestation = snapshot.get("attestation") or snapshot.get("selectionAttestation")
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
                if expires_dt < datetime.now(timezone.utc):
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

    signal = state.get("signal")
    snapshot = state.get("trusted_snapshot") or state.get("snapshot")
    if hasattr(snapshot, "model_dump"):
        snapshot = snapshot.model_dump(mode="json")

    if not signal or not isinstance(signal, dict) or not snapshot or not isinstance(snapshot, dict):
        logger.info("create_handoff_token_invalid_state")
        return {"action": {"error": "Invalid state for handoff creation."}}

    attestation = snapshot.get("attestation") or snapshot.get("selectionAttestation")
    offer_index = (
        signal.get("offer_index")
        if signal.get("offer_index") is not None
        else signal.get("selected_index")
    )
    fingerprint = snapshot.get("fingerprint")

    try:
        client = get_nestjs_client(config)
        response = await client.create_handoff_token(
            attestation=attestation,
            selected_offer_index=offer_index,
            fingerprint=fingerprint,
        )

        if not isinstance(response, dict) or "error" in response:
            logger.error("create_handoff_token_upstream_error")
            return {"action": {"error": "Checkout handoff could not be created."}}

        handoff_token = response.get("handoffToken") or response.get("token")
        expires_at = response.get("expiresAt")

        if not handoff_token:
            logger.error("create_handoff_token_missing_token")
            return {"action": {"error": "Checkout handoff could not be created."}}

        source_item = {}
        if isinstance(snapshot, dict) and offer_index is not None:
            try:
                idx = int(offer_index) - 1
                results = snapshot.get("results") or snapshot.get("offers") or []
                if (
                    isinstance(results, list)
                    and 0 <= idx < len(results)
                    and isinstance(results[idx], dict)
                ):
                    source_item.update(results[idx])
            except (ValueError, TypeError):
                logger.debug("create_handoff_token_source_item_parse_failed")

        if isinstance(response.get("display"), dict):
            source_item.update(response.get("display"))

        display_info = None
        if source_item:
            formatted = {}
            for field in _ALLOWLISTED_DISPLAY_FIELDS:
                val = source_item.get(field)
                if val is None:
                    if field == "origin":
                        val = source_item.get("departureAirport")
                    elif field == "destination":
                        val = source_item.get("arrivalAirport")
                    elif field == "departureAt":
                        val = source_item.get("departureTime")
                    elif field == "arrivalAt":
                        val = source_item.get("arrivalTime")
                if val is not None:
                    if isinstance(val, datetime):
                        formatted[field] = val.isoformat()
                    elif field == "price":
                        formatted[field] = str(val)
                    else:
                        formatted[field] = val
            if formatted:
                display_info = formatted

        return {
            "action": {
                "action": "begin_checkout",
                "handoffToken": handoff_token,
                "expiresAt": expires_at,
                "display": display_info,
            }
        }
    except Exception:
        logger.error("create_handoff_token_failed")
        return {"action": {"error": "Checkout handoff could not be created."}}


create_handoff_token_node = create_handoff_token
