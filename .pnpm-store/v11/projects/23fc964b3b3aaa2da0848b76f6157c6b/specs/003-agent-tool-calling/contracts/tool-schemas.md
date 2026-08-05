# Contract: Tool Function Schemas

**Feature**: 003 — Agent Tool-Calling & Data Access
**Phase**: 1 — Design Contracts
**Date**: 2026-07-01

---

## Overview

Three LangChain tools with OpenAI-compatible function calling schemas. All tools are read-only (`requires_confirmation: false`). Each tool wraps an `httpx` call to the corresponding Agent Gateway endpoint.

Tool responses are formatted as **structured text summaries** for the LLM context — not raw JSON dumps. This keeps the context window clean and helps the LLM produce natural conversational answers.

**Tool registration location**: `apps/agent/src/agent/tools/registry.py`

---

## 1. `search_flights`

**Description**: Search for available flights between two airports on a specific date.

**`requires_confirmation`**: `false`

**Maps to**: `GET /api/agent-gateway/flights/search`

### OpenAI Function Schema

```json
{
  "type": "function",
  "function": {
    "name": "search_flights",
    "description": "Search for available flights between two airports on a specific date. Returns the top 5 matching flights with airline, times, price, and baggage information. Use this when the user asks to find, search, or look up flights.",
    "parameters": {
      "type": "object",
      "properties": {
        "origin": {
          "type": "string",
          "description": "Departure airport IATA code (3 letters, e.g. HAN, SGN, NRT)"
        },
        "destination": {
          "type": "string",
          "description": "Arrival airport IATA code (3 letters, e.g. NRT, ICN, SIN)"
        },
        "date": {
          "type": "string",
          "description": "Travel date in YYYY-MM-DD format (must be a future date)"
        },
        "passengers": {
          "type": "integer",
          "description": "Number of passengers (1-9)",
          "default": 1
        }
      },
      "required": ["origin", "destination", "date"],
      "additionalProperties": false
    }
  }
}
```

### Return Format

Structured text summary, not raw JSON. Example:

```text
Found 3 flights from HAN to NRT on 2026-07-15:

1. Vietnam Airlines VN310
   Departs: 08:30 HAN → Arrives: 15:00 NRT
   Duration: 5h 30m | Direct
   Price: $452.00 USD (Economy)
   Baggage: 23kg checked + 7kg carry-on

2. ANA NH858
   Departs: 10:15 HAN → Arrives: 17:45 NRT
   Duration: 6h 30m | 1 stop
   Price: $389.00 USD (Economy)
   Baggage: 23kg checked + 7kg carry-on

3. Japan Airlines JL752
   Departs: 14:00 HAN → Arrives: 22:30 NRT
   Duration: 7h 30m | 1 stop
   Price: $415.00 USD (Economy)
   Baggage: 23kg checked + 7kg carry-on
```

### Error Return

When the gateway returns an error, the tool returns a user-friendly error string:

```text
I couldn't search for flights right now. The flight search service is temporarily unavailable. Please try again in a moment.
```

---

## 2. `get_user_preferences`

**Description**: Retrieve the current user's saved travel preferences.

**`requires_confirmation`**: `false`

**Maps to**: `GET /api/agent-gateway/users/preferences`

### OpenAI Function Schema

```json
{
  "type": "function",
  "function": {
    "name": "get_user_preferences",
    "description": "Retrieve the current user's saved travel preferences including seat preference, class preference, preferred airlines, blacklisted airlines, and dietary needs. Use this when the user asks about their preferences or when you need to personalize recommendations.",
    "parameters": {
      "type": "object",
      "properties": {},
      "required": [],
      "additionalProperties": false
    }
  }
}
```

### Return Format

Structured text summary. Example:

```text
Your travel preferences:
- Seat: Window
- Class: Business
- Preferred airlines: Vietnam Airlines, ANA
- Blacklisted airlines: None
- Dietary needs: Vegetarian
```

When no profile exists:

```text
You don't have any travel preferences saved yet. You can set them up in your profile settings.
```

### Error Return

```text
I couldn't retrieve your preferences right now. Please try again in a moment.
```

---

## 3. `list_user_bookings`

**Description**: Retrieve the current user's active flight bookings.

**`requires_confirmation`**: `false`

**Maps to**: `GET /api/agent-gateway/users/bookings`

### OpenAI Function Schema

```json
{
  "type": "function",
  "function": {
    "name": "list_user_bookings",
    "description": "Retrieve the current user's active flight bookings including flight details, dates, status, and pricing. Use this when the user asks about their bookings, upcoming flights, or trip details.",
    "parameters": {
      "type": "object",
      "properties": {},
      "required": [],
      "additionalProperties": false
    }
  }
}
```

### Return Format

Structured text summary. Example:

```text
You have 2 active bookings:

1. Vietnam Airlines VN310 — CONFIRMED
   HAN → NRT on Jul 15, 2026
   Departs: 08:30 → Arrives: 15:00
   Duration: 5h 30m | Direct
   Class: Business | Price: $1,250.00 USD
   Passengers: 1 | Baggage: 32kg checked + 7kg carry-on

2. ANA NH856 — CONFIRMED
   NRT → HAN on Jul 22, 2026
   Departs: 11:00 → Arrives: 14:30
   Duration: 5h 30m | Direct
   Class: Business | Price: $1,180.00 USD
   Passengers: 1 | Baggage: 32kg checked + 7kg carry-on
```

When no bookings exist:

```text
You don't have any active bookings at the moment.
```

### Error Return

```text
I couldn't retrieve your bookings right now. Please try again in a moment.
```

---

## Tool Registry Summary

| Tool                   | `requires_confirmation` | Parameters           | Gateway Endpoint                          |
|------------------------|------------------------|----------------------|-------------------------------------------|
| `search_flights`       | `false`                | origin, destination, date, passengers | `GET /api/agent-gateway/flights/search`  |
| `get_user_preferences` | `false`                | none                 | `GET /api/agent-gateway/users/preferences`|
| `list_user_bookings`   | `false`                | none                 | `GET /api/agent-gateway/users/bookings`   |

---

## Adding New Tools

To add a new tool (per FR-016), define:

1. **Tool schema** — OpenAI function calling JSON (in `tools/<tool_name>.py`)
2. **Gateway endpoint** — corresponding `GET` or `POST` route in `agent-gateway.controller.ts`
3. **`requires_confirmation` flag** — `false` for read-only, `true` for write operations

Register in `registry.py`. No changes to graph orchestration layer required — the router reads the `requires_confirmation` flag dynamically.
