from datetime import datetime
from typing import Any

AIRLINE_MAP: dict[str, str] = {
    "VN": "Vietnam Airlines",
    "NH": "ANA",
    "JL": "Japan Airlines",
    "SQ": "Singapore Airlines",
}

MATCH_LEVEL_MAP: dict[str, str] = {
    "STRONG": "Strong Match",
    "GOOD": "Good Match",
    "FAIR": "Fair Match",
    "WEAK": "Weak Match",
}


def _format_time(val: Any) -> str:
    if not val:
        return ""
    if isinstance(val, str):
        val = val.strip()
        if len(val) == 5 and val[2] == ":":
            return val
        try:
            dt = datetime.fromisoformat(val.replace("Z", "+00:00"))
            return dt.strftime("%H:%M")
        except Exception:
            if "T" in val:
                time_part = val.split("T")[1]
                return time_part[:5]
            return val
    if isinstance(val, datetime):
        return val.strftime("%H:%M")
    return str(val)


def _format_duration(val: Any) -> str:
    if val is None:
        return ""
    if isinstance(val, (int, float)):
        minutes = int(val)
        hours = minutes // 60
        mins = minutes % 60
        if hours > 0 and mins > 0:
            return f"{hours}h {mins}m"
        if hours > 0:
            return f"{hours}h"
        return f"{mins}m"
    if isinstance(val, str):
        val = val.strip()
        if val.isdigit():
            return _format_duration(int(val))
        return val
    return str(val)


def _format_stops(stops: Any) -> str:
    if stops is None:
        return ""
    try:
        stops_num = int(stops)
        if stops_num == 0:
            return "Direct"
        if stops_num == 1:
            return "1 stop"
        return f"{stops_num} stops"
    except (ValueError, TypeError):
        return str(stops)


def _format_price(price: Any, currency: str = "USD") -> str:
    if price is None:
        return ""
    try:
        price_num = float(price)
        formatted_num = f"{price_num:,.2f}"
        return (
            f"${formatted_num} {currency}" if currency == "USD" else f"{formatted_num} {currency}"
        )
    except (ValueError, TypeError):
        return f"{price} {currency}"


def _format_explanation(explanation: Any) -> str:
    try:
        if isinstance(explanation, str):
            cleaned = explanation.strip()
            if cleaned.startswith("•"):
                cleaned = cleaned.lstrip("•").strip()
            return cleaned or "Matches search criteria"

        if not isinstance(explanation, dict):
            return "Matches search criteria"

        key = explanation.get("key")
        params = explanation.get("params") or {}
        if not isinstance(params, dict):
            params = {}

        if key == "match.price.below_median":
            percent = params.get("percentDiff") or params.get("percentBelow")
            if percent is not None:
                return f"{percent}% below median price"
            diff = params.get("difference")
            if diff is not None:
                diff_str = str(diff)
                if not diff_str.endswith("%"):
                    diff_str = f"{diff_str}%"
                return f"{diff_str} below median price"
            return "Below median price"

        if key == "match.price.above_median":
            percent = params.get("percentDiff")
            if percent is not None:
                return f"{percent}% above median price"
            return "Above median price"

        if key == "match.price.at_median":
            return "At median price"

        if key == "match.airline.preferred":
            airline = params.get("airline")
            if airline:
                return f"Matches preferred airline ({airline})"
            return "Matches preferred airline"

        if key == "match.airline.neutral":
            return "Standard airline match"

        if key == "match.arrival.in_window":
            start = params.get("windowStart")
            end = params.get("windowEnd")
            if start is not None and end is not None:
                return f"Arrives within preferred window ({start}:00–{end}:00)"
            return "Arrives within preferred window"

        if key == "match.arrival.near_window":
            return "Arrives near preferred window"

        if key == "match.arrival.outside_window":
            return "Arrives outside preferred window"

        if key == "match.departure.in_window":
            start = params.get("windowStart")
            end = params.get("windowEnd")
            if start is not None and end is not None:
                return f"Departs within preferred window ({start}:00–{end}:00)"
            return "Departs within preferred window"

        if key == "match.departure.near_window":
            return "Departs near preferred window"

        if key == "match.departure.outside_window":
            return "Departs outside preferred window"

        if key == "match.stops.within_preference":
            stops = params.get("stops")
            if stops is not None:
                return f"Within preferred stops ({stops} stops)"
            return "Within preferred stops"

        if key == "match.stops.exceeds_preference":
            stops = params.get("stops")
            max_stops = params.get("maxStops")
            if stops is not None and max_stops is not None:
                return f"Exceeds preferred stops ({stops} stops, max {max_stops})"
            return "Exceeds preferred stops"

        if key == "match.stops.relative":
            stops = params.get("stops")
            if stops == 0:
                return "Direct flight"
            if stops is not None:
                return f"{stops} stops"
            return "Flight with stops"

        if key == "match.cabin.exact":
            return "Matches requested cabin"

        if key == "match.cabin.adjacent":
            return "Adjacent cabin class"

        if key == "match.cabin.mismatch":
            return "Cabin mismatch"

        if key == "match.baggage.checked_included":
            return "Checked bag included"

        if key == "match.baggage.checked_missing":
            return "Checked bag not included"

        if key == "match.baggage.not_required":
            return "No baggage requirement"

        if key == "match.duration.below_median":
            return "Shorter than median duration"

        if key == "match.duration.at_median":
            return "Median duration"

        if key == "match.duration.above_median":
            return "Longer than median duration"

        if key == "constraint.airline.blacklisted":
            airline = params.get("airline")
            if airline:
                return f"Blacklisted airline ({airline})"
            return "Blacklisted airline"

        return "Matches search criteria"
    except Exception:
        return "Matches search criteria"


def _extract_explanations(match_result: dict) -> list[str]:
    explanations: list[str] = []

    eligibility = match_result.get("eligibility")
    if isinstance(eligibility, dict):
        violations = eligibility.get("violations", [])
        if isinstance(violations, list):
            for v in violations:
                if isinstance(v, dict):
                    exp = v.get("explanation")
                    if exp:
                        formatted = _format_explanation(exp)
                        if formatted:
                            explanations.append(formatted)
                    else:
                        explanations.append("Matches search criteria")

    breakdown = match_result.get("breakdown", [])
    if isinstance(breakdown, list):
        for item in breakdown:
            if isinstance(item, dict):
                exp = item.get("explanation")
                if exp:
                    formatted = _format_explanation(exp)
                    if formatted:
                        explanations.append(formatted)
                elif "dimension" in item and item.get("dimension"):
                    explanations.append("Matches search criteria")

    direct_exps = match_result.get("explanations", [])
    if isinstance(direct_exps, list):
        for exp in direct_exps:
            formatted = _format_explanation(exp)
            if formatted:
                explanations.append(formatted)

    return explanations


def _format_flight_block(idx: int, flight: dict, mode: str) -> str:
    airline_code = flight.get("airline") or ""
    airline_name = AIRLINE_MAP.get(airline_code, airline_code or "Unknown Airline")

    route_dep = flight.get("departureAirport") or flight.get("origin") or ""
    route_arr = flight.get("arrivalAirport") or flight.get("destination") or ""
    route_str = f"{route_dep} → {route_arr}" if route_dep and route_arr else ""

    dep_time = _format_time(flight.get("departureTime") or flight.get("departureAt"))
    arr_time = _format_time(flight.get("arrivalTime") or flight.get("arrivalAt"))
    times_str = f"Departs: {dep_time} | Arrives: {arr_time}" if dep_time or arr_time else ""

    duration_str = _format_duration(flight.get("duration"))
    stops_val = flight.get("stops")
    stops_str = _format_stops(stops_val)
    flight_facts = []
    if duration_str:
        flight_facts.append(f"Duration: {duration_str}")
    if stops_str:
        flight_facts.append(f"Stops: {stops_str}")
    facts_line = " | ".join(flight_facts)

    price_str = _format_price(flight.get("price"), flight.get("currency", "USD"))
    price_line = f"Price: {price_str}" if price_str else ""

    baggage = flight.get("baggageAllowance") or flight.get("baggage")
    baggage_line = f"Baggage: {baggage}" if baggage else ""

    lines = [f"{idx}. {airline_name}"]
    if route_str:
        lines.append(f"   Route: {route_str}")
    if times_str:
        lines.append(f"   {times_str}")
    if facts_line:
        lines.append(f"   {facts_line}")
    if price_line:
        lines.append(f"   {price_line}")
    if baggage_line:
        lines.append(f"   {baggage_line}")

    if mode == "MATCHED":
        match_result = flight.get("matchResult")
        if isinstance(match_result, dict):
            score = match_result.get("score")
            match_level = match_result.get("matchLevel")
            level_str = (
                MATCH_LEVEL_MAP.get(str(match_level).upper(), match_level) if match_level else ""
            )

            if score is not None and level_str:
                lines.append(f"   Match Score: {score}/100 ({level_str})")
            elif score is not None:
                lines.append(f"   Match Score: {score}/100")
            elif level_str:
                lines.append(f"   Match Level: {level_str}")

            explanations = _extract_explanations(match_result)
            for exp in explanations:
                lines.append(f"   • {exp}")

    return "\n".join(lines)


def project_flight_search_for_narration(data: dict) -> str:
    """Project flight search response for LLM narration.

    Strips provider IDs, local UUIDs, attestation signatures, and PII.
    Differentiates between MATCHED mode (with score, level, explanations)
    and RANKED mode (disclaimer, zero score claims).
    """
    if not isinstance(data, dict):
        return "Found 0 flights."

    results = data.get("results")
    if not results or not isinstance(results, list):
        origin = data.get("origin")
        destination = data.get("destination")
        date = data.get("date") or data.get("departureDate")
        if origin and destination and date:
            return f"Found 0 flights from {origin} to {destination} on {date}."
        if origin and destination:
            return f"Found 0 flights from {origin} to {destination}."
        return "Found 0 flights."

    mode = str(data.get("mode", "")).upper()
    if not mode:
        has_match = any(
            isinstance(r, dict)
            and isinstance(r.get("matchResult"), dict)
            and r["matchResult"].get("score") is not None
            for r in results
        )
        mode = "MATCHED" if has_match else "RANKED"

    top_flights = results[:5]
    flight_blocks = [
        _format_flight_block(idx, flight, mode)
        for idx, flight in enumerate(top_flights, 1)
        if isinstance(flight, dict)
    ]

    parts = []
    if mode == "RANKED":
        parts.append(
            f"Found {len(flight_blocks)} flights:\n\n"
            + "Standard category ranking by stops, price, duration. Set preferences in profile for personalized matches\n\n"
            + "\n\n".join(flight_blocks)
        )
    else:
        parts.append(
            f"Found {len(flight_blocks)} matching flights:\n\n" + "\n\n".join(flight_blocks)
        )

    return "\n\n".join(parts)
