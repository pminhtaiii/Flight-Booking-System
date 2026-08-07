from typing import Dict, Any, List
from langchain_core.tools import tool
from langchain_core.runnables import RunnableConfig
from agent.tools.base import get_nestjs_client
import logging

logger = logging.getLogger(__name__)

@tool("list_user_booking_summaries")
async def list_user_booking_summaries(config: RunnableConfig) -> str:
    """List the authenticated user's flight booking summaries.
    Returns opaque booking references, airlines, routes, flight times, and status.
    Does not expose detailed flight numbers, baggage, or financial data.
    """
    try:
        client = get_nestjs_client(config)
    except Exception:
        return "Failed to fetch booking summaries."

    
    try:
        response = await client.get_gateway_user_booking_summaries()
        summaries = response.get("summaries", [])
        if not summaries:
            return "No bookings found."
        
        result = []
        for s in summaries:
            ref = s.get("agentReference", "Unknown")
            status = s.get("status", "Unknown")
            airline = s.get("airline", "Unknown")
            origin = s.get("origin", "Unknown")
            dest = s.get("destination", "Unknown")
            dept = s.get("departureAt", "Unknown")
            arr = s.get("arrivalAt", "Unknown")
            duration = s.get("durationMinutes", 0)
            stops = s.get("stopCount", 0)
            
            result.append(f"- [{status}] {airline} from {origin} to {dest}. "
                          f"Departs {dept}, Arrives {arr}. Duration: {duration} mins, Stops: {stops}. (Ref: {ref})")
            
        return "\n".join(result)
    except Exception as e:
        logger.error(f"Failed to fetch booking summaries: {e}")
        return "Failed to fetch booking summaries."
