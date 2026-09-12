import httpx
from langchain_core.runnables import RunnableConfig
from langchain_core.tools import tool

from agent.guardrails.schemas.tools import (
    GetPreferencesToolInput,
    GetPreferencesToolResult,
    PreferencesUpstreamProjection,
    project_upstream,
)
from agent.tools.base import get_nestjs_client

AIRLINE_MAP = {
    "VN": "Vietnam Airlines",
    "NH": "ANA",
    "JL": "Japan Airlines",
    "SQ": "Singapore Airlines",
}


def _narration(value: str) -> str:
    return GetPreferencesToolResult(narration=value).narration


@tool("get_user_preferences", args_schema=GetPreferencesToolInput)
async def get_user_preferences(config: RunnableConfig) -> str:
    """Retrieve the current user's saved travel preferences including seat preference, class preference, preferred airlines, blacklisted airlines, and dietary needs. Use this when the user asks about their preferences or when you need to personalize recommendations."""
    try:
        client = get_nestjs_client(config)
    except Exception:
        return _narration(
            "I couldn't retrieve your preferences right now. Please try again in a moment."
        )

    try:
        data = await client.get_gateway_user_preferences()
    except httpx.HTTPStatusError as exc:
        try:
            err_json = exc.response.json()
            code = err_json.get("code")
        except Exception:
            code = None

        if exc.response.status_code == 404 or code == "PROFILE_NOT_FOUND":
            return _narration(
                "You don't have any travel preferences saved yet. You can set them up in your profile settings."
            )
        return _narration(
            "I couldn't retrieve your preferences right now. Please try again in a moment."
        )
    except Exception:
        return _narration(
            "I couldn't retrieve your preferences right now. Please try again in a moment."
        )

    try:
        preferences = project_upstream(PreferencesUpstreamProjection, data)
    except Exception:
        return _narration(
            "I couldn't retrieve your preferences right now. Please try again in a moment."
        )

    seat = preferences.seatPreference
    seat_str = seat.title() if seat else "None"

    class_pref = preferences.classPreference
    class_str = class_pref.title() if class_pref else "None"

    pref_airlines = preferences.preferredAirlines
    mapped_pref = [AIRLINE_MAP.get(code, code) for code in pref_airlines]
    pref_str = ", ".join(mapped_pref) if mapped_pref else "None"

    black_airlines = preferences.blacklistedAirlines
    mapped_black = [AIRLINE_MAP.get(code, code) for code in black_airlines]
    black_str = ", ".join(mapped_black) if mapped_black else "None"

    dietary = preferences.dietaryNeeds
    dietary_str = dietary.title() if dietary else "None"

    lines = [
        "Your travel preferences:",
        f"- Seat: {seat_str}",
        f"- Class: {class_str}",
        f"- Preferred airlines: {pref_str}",
        f"- Blacklisted airlines: {black_str}",
        f"- Dietary needs: {dietary_str}",
    ]
    return _narration("\n".join(lines))
