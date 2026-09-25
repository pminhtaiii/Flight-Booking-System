"""Domain projections and event resolution for tool outputs and handoff nodes."""

import json
import logging
from dataclasses import dataclass
from typing import Optional, Union

from agent.chat_turn.events import (
    ActionHandoffEvent,
    ActionHandoffPayload,
    ActionRequiredEvent,
    ActionRequiredPayload,
    FlightResultsEvent,
    FlightResultsPayload,
)
from agent.tools.nestjs_client import validate_booking_readiness_response
from agent.trusted_search_snapshot import (
    SnapshotOwner,
    TrustedSearchSnapshotLifecycle,
    TrustedSnapshotRepository,
)

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class ToolResolution:
    """Resolution outcome for an executed tool call."""

    is_blocked: bool = False
    summary_override: Optional[str] = None
    follow_up_event: Optional[Union[FlightResultsEvent, ActionRequiredEvent]] = None
    error_code: Optional[str] = None
    error_message: Optional[str] = None
    error_detail: Optional[str] = None


@dataclass(frozen=True)
class HandoffResolution:
    """Resolution outcome for a completed handoff node."""

    is_blocked: bool = False
    handoff_event: Optional[ActionHandoffEvent] = None
    force_persistence: bool = False
    error_code: Optional[str] = None
    error_message: Optional[str] = None
    error_detail: Optional[str] = None


class ToolResultResolver:
    """Resolves tool results and node outputs into typed domain events and resolutions."""

    def __init__(
        self,
        snapshot_lifecycle: Optional[TrustedSearchSnapshotLifecycle] = None,
    ) -> None:
        self.snapshot_lifecycle = snapshot_lifecycle

    @staticmethod
    def _validate_readiness(data: dict[str, object]) -> Optional[dict[str, object]]:
        validated = validate_booking_readiness_response(data)
        if validated is not None:
            return validated

        if not isinstance(data.get("ready"), bool):
            return None
        if not isinstance(data.get("nextAction"), str):
            return None
        passengers = data.get("passengers")
        if passengers is not None and not isinstance(passengers, list):
            return None

        safe_passengers: list[dict[str, object]] = []
        if isinstance(passengers, list):
            for passenger in passengers:
                if not isinstance(passenger, dict):
                    return None
                safe_sections: list[dict[str, object]] = []
                sections = passenger.get("sections")
                if isinstance(sections, list):
                    for section in sections:
                        if not isinstance(section, dict):
                            return None
                        safe_fields: list[dict[str, object]] = []
                        fields = section.get("fields")
                        if isinstance(fields, list):
                            for field in fields:
                                if not isinstance(field, dict):
                                    return None
                                safe_fields.append(
                                    {
                                        "name": field.get("name"),
                                        "status": field.get("status"),
                                        "reason": field.get("reason"),
                                    }
                                )
                        safe_sections.append(
                            {
                                "name": section.get("name"),
                                "fields": safe_fields,
                            }
                        )
                safe_passengers.append(
                    {
                        "passengerType": passenger.get("passengerType"),
                        "passengerOrdinal": passenger.get("passengerOrdinal"),
                        "sections": safe_sections,
                    }
                )

        return {
            "scope": data.get("scope"),
            "ready": data["ready"],
            "passengers": safe_passengers,
            "nextAction": data["nextAction"],
        }

    @staticmethod
    def _extract_safe_passengers(passengers_raw: object) -> list[dict[str, object]]:
        if not isinstance(passengers_raw, list):
            return []
        safe_passengers: list[dict[str, object]] = []
        for passenger in passengers_raw:
            if not isinstance(passenger, dict):
                continue
            safe_sections: list[dict[str, object]] = []
            sections_raw = passenger.get("sections")
            if isinstance(sections_raw, list):
                for section in sections_raw:
                    if not isinstance(section, dict):
                        continue
                    safe_fields: list[dict[str, object]] = []
                    fields_raw = section.get("fields")
                    if isinstance(fields_raw, list):
                        for field in fields_raw:
                            if not isinstance(field, dict):
                                continue
                            safe_fields.append(
                                {
                                    "name": field.get("name"),
                                    "status": field.get("status"),
                                    "reason": field.get("reason"),
                                }
                            )
                    safe_sections.append(
                        {
                            "name": section.get("name"),
                            "fields": safe_fields,
                        }
                    )
            safe_passengers.append(
                {
                    "passengerType": passenger.get("passengerType"),
                    "passengerOrdinal": passenger.get("passengerOrdinal"),
                    "sections": safe_sections,
                }
            )
        return safe_passengers

    async def resolve(
        self,
        tool_name: str,
        validated_result: object,
        context: object,
    ) -> ToolResolution:
        if tool_name == "check_booking_readiness":
            output_data: object = validated_result
            if isinstance(output_data, str):
                try:
                    output_data = json.loads(output_data)
                except (json.JSONDecodeError, TypeError, ValueError):
                    pass

            if not isinstance(output_data, dict) or "error" in output_data:
                return ToolResolution(
                    is_blocked=True,
                    error_code="READINESS_RESPONSE_INVALID",
                    error_message="Booking readiness could not be verified safely.",
                )

            safe_readiness = self._validate_readiness(output_data)
            if safe_readiness is None:
                return ToolResolution(
                    is_blocked=True,
                    error_code="READINESS_RESPONSE_INVALID",
                    error_message="Booking readiness could not be verified safely.",
                )

            if safe_readiness.get("ready") is True:
                return ToolResolution(
                    is_blocked=False,
                    summary_override="Successfully checked booking readiness.",
                    follow_up_event=None,
                )

            action = str(safe_readiness.get("nextAction") or "")
            raw_scope = safe_readiness.get("scope")
            scope = str(raw_scope) if raw_scope is not None else None

            safe_passengers = self._extract_safe_passengers(safe_readiness.get("passengers"))
            target = "/profile" if action == "COMPLETE_PROFILE" else "/checkout/passengers"

            return ToolResolution(
                is_blocked=False,
                summary_override="Successfully checked booking readiness.",
                follow_up_event=ActionRequiredEvent(
                    data=ActionRequiredPayload(
                        action=action,
                        scope=scope,
                        passengers=safe_passengers,
                        target=target,
                    )
                ),
            )

        if tool_name == "search_flights":
            lifecycle = self.snapshot_lifecycle or getattr(context, "snapshot_lifecycle", None)
            if lifecycle is None:
                repo = getattr(context, "snapshot_repository", None)
                redis_client = getattr(context, "redis_client", None)
                if repo is not None:
                    lifecycle = TrustedSearchSnapshotLifecycle(repo)
                elif redis_client is not None:
                    lifecycle = TrustedSearchSnapshotLifecycle(
                        TrustedSnapshotRepository(redis_client)
                    )

            user_id = str(getattr(context, "user_id", "") or "")
            session_id = str(
                getattr(context, "session_id", getattr(context, "chat_session_id", "")) or ""
            )

            if lifecycle is not None and user_id and session_id:
                try:
                    owner = SnapshotOwner(user_id=user_id, chat_session_id=session_id)
                    latest_snapshot = await lifecycle.load_active(owner)
                    if latest_snapshot:
                        projected = lifecycle.project_for_browser(latest_snapshot)
                        if projected:
                            raw_results: list[dict[str, object]] = [
                                res.model_dump(mode="json") if hasattr(res, "model_dump") else res
                                for res in projected
                            ]
                            return ToolResolution(
                                is_blocked=False,
                                follow_up_event=FlightResultsEvent(
                                    data=FlightResultsPayload(results=raw_results)
                                ),
                            )
                except Exception:
                    logger.warning("search_result_projection_failed")

            return ToolResolution(is_blocked=False, follow_up_event=None)

        summary_str = (
            validated_result
            if isinstance(validated_result, str)
            else json.dumps(validated_result, ensure_ascii=False)
            if isinstance(validated_result, dict)
            else "Tool completed safely."
        )
        return ToolResolution(
            is_blocked=False,
            summary_override=summary_str,
            follow_up_event=None,
        )

    def resolve_handoff_node(
        self,
        node_name: str,
        node_output: object,
        context: object,
    ) -> HandoffResolution:
        if node_name not in (
            "create_handoff_token",
            "create_handoff_token_node",
            "validate_handoff",
        ):
            return HandoffResolution(is_blocked=False, handoff_event=None, force_persistence=False)

        if not isinstance(node_output, dict):
            return HandoffResolution(is_blocked=False, handoff_event=None, force_persistence=False)

        action_res: object = (
            node_output.get("action")
            if "action" in node_output and isinstance(node_output.get("action"), dict)
            else node_output
        )

        if isinstance(action_res, dict) and "error" in action_res:
            err_msg = str(action_res.get("error") or "Checkout handoff could not be created.")
            return HandoffResolution(
                is_blocked=True,
                error_code="HANDOFF_FAILED",
                error_message=err_msg,
                error_detail=err_msg,
            )

        if isinstance(action_res, dict):
            handoff_token = action_res.get("handoffToken") or action_res.get("token")
            action_type = action_res.get("action")
            if isinstance(handoff_token, str) and action_type == "begin_checkout":
                expires_at = str(action_res.get("expiresAt") or "")
                raw_display = action_res.get("display")
                display: dict[str, object] = (
                    dict(raw_display) if isinstance(raw_display, dict) else {}
                )
                payload = ActionHandoffPayload(
                    version=1,
                    action="begin_checkout",
                    handoffToken=handoff_token,
                    expiresAt=expires_at,
                    display=display,
                )
                return HandoffResolution(
                    is_blocked=False,
                    handoff_event=ActionHandoffEvent(data=payload),
                    force_persistence=True,
                )

        return HandoffResolution(is_blocked=False, handoff_event=None, force_persistence=False)


__all__ = ["HandoffResolution", "ToolResolution", "ToolResultResolver"]
