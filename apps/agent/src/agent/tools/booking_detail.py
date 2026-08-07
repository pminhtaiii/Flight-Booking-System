from typing import Dict, Any, List
from langchain_core.tools import tool
from langchain_core.runnables import RunnableConfig
from agent.tools.base import get_nestjs_client
import logging

logger = logging.getLogger(__name__)

@tool("get_booking_detail")
async def get_booking_detail(agent_reference: str, config: RunnableConfig) -> str:
    """Get explicitly requested details for a specific flight booking.
    Requires the opaque agent_reference obtained from list_user_booking_summaries.
    Returns flight number, baggage allowance, and fare policies (if available).
    Does not expose financial data, passenger names, or PNRs.
    """
    try:
        client = get_nestjs_client(config)
    except Exception:
        return f"Error: Failed to fetch booking detail for {agent_reference}."
    
    try:
        response = await client.get_gateway_booking_detail(agent_reference)
        
        if "error" in response or response.get("statusCode") == 404:
            return "Not found: The booking detail could not be found for the given reference."
            
        status = response.get("status", "Unknown")
        airline = response.get("airline", "Unknown")
        origin = response.get("origin", "Unknown")
        dest = response.get("destination", "Unknown")
        dept = response.get("departureAt", "Unknown")
        arr = response.get("arrivalAt", "Unknown")
        flight_num = response.get("flightNumber", "Unknown")
        baggage_summary = response.get("baggageSummary", "Not specified")
        refundable = response.get("refundable", "Unknown")
        changeable = response.get("changeable", "Unknown")
        
        result = (
            f"Booking {agent_reference} Detail:\n"
            f"- Status: {status}\n"
            f"- Flight: {airline} {flight_num} from {origin} to {dest}\n"
            f"- Departure: {dept}\n"
            f"- Arrival: {arr}\n"
            f"- Baggage: {baggage_summary}\n"
            f"- Refundable: {refundable}\n"
            f"- Changeable: {changeable}"
        )
        return result
    except Exception as e:
        logger.error(f"Failed to fetch booking detail for {agent_reference}: {e}")
        return f"Error: Failed to fetch booking detail for {agent_reference}."
