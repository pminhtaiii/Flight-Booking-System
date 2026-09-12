from langchain_core.runnables import RunnableConfig
from langchain_core.tools import tool

from agent.guardrails.schemas.tools import (
    CheckBookingReadinessToolInput,
    CheckBookingReadinessToolResult,
    PassengerToolInput,
    project_booking_readiness_upstream,
)


@tool("check_booking_readiness", args_schema=CheckBookingReadinessToolInput)
async def check_booking_readiness(
    flight_offer_id: str, passengers: list[PassengerToolInput], config: RunnableConfig = None
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
            return CheckBookingReadinessToolResult(
                error="NestJSClient not found in configuration."
            ).model_dump(exclude_none=True)

        client = config["configurable"]["nestjs_client"]
        safe_passengers = [passenger.model_dump() for passenger in passengers]
        response = await client.check_booking_readiness(flight_offer_id, safe_passengers)
        return project_booking_readiness_upstream(response).model_dump(exclude_none=True)
    except Exception:
        # Use generic safe wording for failures
        return CheckBookingReadinessToolResult(
            error="Failed to check booking readiness safely. Internal error occurred."
        ).model_dump(exclude_none=True)
