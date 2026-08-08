import json
from langchain_core.messages import SystemMessage, HumanMessage, ToolMessage
from langchain_core.runnables import RunnableConfig
from langgraph.prebuilt import ToolNode

from agent.agents.chat_agent import get_chat_model
from agent.config import get_settings
from agent.tools.registry import get_tools
from agent.tools.nestjs_client import validate_booking_readiness_response
from agent.tools.base import get_nestjs_client
from agent.graph.state import AgentState
from agent.agents.travel_assistant import TRAVEL_PROMPT

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
            if hasattr(msg, 'content') and isinstance(msg.content, str):
                try:
                    data = json.loads(msg.content)
                    if isinstance(data, dict) and "signal" in data:
                        update_dict["signal"] = data["signal"]
                        # Mask the content so the LLM sees a natural response
                        msg.content = "Checkout intent registered successfully."
                except json.JSONDecodeError:
                    pass
    elif isinstance(result, list):
        update_dict["messages"] = result
    else:
        # Fallback if ToolNode returns something else
        update_dict.update(result)
        
    return update_dict

async def validate_handoff(state: AgentState, config: RunnableConfig) -> dict:
    """Validate snapshot and signal before creating handoff."""
    signal = state.get("signal")
    if not signal or "offer_index" not in signal:
        return {"action": {"error": "Missing checkout signal."}}
        
    snapshot = state.get("trusted_snapshot")
    if not snapshot or ("version" not in snapshot and "snapshotVersion" not in snapshot) or ("attestation" not in snapshot and "selectionAttestation" not in snapshot):
        return {"action": {"error": "Missing or invalid trusted snapshot."}}
        
    return {}

async def create_handoff_token(state: AgentState, config: RunnableConfig) -> dict:
    """Create a handoff token using NestJSClient and emit action."""
    if not get_settings().FEATURE_FLAG_CHAT_HANDOFF_ISSUE:
        return {"action": {"error": "Chat handoff issuance is disabled."}}

    signal = state.get("signal")
    snapshot = state.get("trusted_snapshot")
    
    if not signal or not snapshot:
        return {"action": {"error": "Invalid state for handoff creation."}}
        
    attestation = snapshot.get("attestation") or snapshot.get("selectionAttestation")
    offer_index = signal.get("offer_index")
    fingerprint = snapshot.get("fingerprint")
    
    try:
        client = get_nestjs_client(config)
        response = await client.create_handoff(
            attestation=attestation,
            offer_index=offer_index,
            fingerprint=fingerprint
        )
        
        if "error" in response:
            return {"action": {"error": response["error"]}}
            
        handoff_token = response.get("handoffToken")
        expires_at = response.get("expiresAt")
        
        if not handoff_token:
            return {"action": {"error": "Failed to create handoff token."}}
            
        display_info = None
        if offer_index and snapshot:
            try:
                idx = int(offer_index) - 1
                results = snapshot.get("results", [])
                if 0 <= idx < len(results):
                    res = results[idx]
                    display_info = {
                        "airline": res.get("airline"),
                        "origin": res.get("departureAirport"),
                        "destination": res.get("arrivalAirport"),
                        "departureAt": res.get("departureTime"),
                        "arrivalAt": res.get("arrivalTime"),
                        "price": str(res.get("price")),
                        "currency": res.get("currency")
                    }
            except (ValueError, TypeError):
                pass
            
        return {
            "action": {
                "action": "begin_checkout",
                "handoffToken": handoff_token,
                "expiresAt": expires_at,
                "display": display_info
            }
        }
    except Exception as e:
        return {"action": {"error": str(e)}}
