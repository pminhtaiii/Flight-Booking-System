from typing import Any, Dict, List

from langchain_core.runnables import RunnableConfig
from langchain_core.tools import tool


@tool("check_booking_readiness")
async def check_booking_readiness(
    flight_offer_id: str, passengers: List[Dict[str, Any]], config: RunnableConfig = None
) -> dict:
    """Check the booking readiness for a flight offer and passenger set.

    This tool safely checks if a given flight offer and passengers (from profile or inline) are ready
    to be booked, identifying any missing required fields.

    Args:
        flight_offer_id (str): The UUID of the selected flight offer.
        passengers (List[Dict[str, Any]]): A list of passenger descriptors. Each MUST contain:
            - passengerType: "ADULT", "CHILD", or "INFANT"
            - passengerOrdinal: integer (1-indexed based on the offer sequence)
            - sourceType: "traveler_profile" or "inline"
    """
    try:
        if (
            config is None
            or "configurable" not in config
            or "nestjs_client" not in config["configurable"]
        ):
            return {"error": "NestJSClient not found in configuration."}

        client = config["configurable"]["nestjs_client"]
        return await client.check_booking_readiness(flight_offer_id, passengers)
    except Exception:
        # Use generic safe wording for failures
        return {"error": "Failed to check booking readiness safely. Internal error occurred."}
