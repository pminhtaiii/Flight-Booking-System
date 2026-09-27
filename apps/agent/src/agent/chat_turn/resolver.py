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

    def project_tool_inputs(self, tool_name: str, raw_args: object) -> dict[str, object]:
        if tool_name == "check_booking_readiness":
            return {"message": "Checking booking readiness..."}
        from agent.guardrails.schemas.tools import TOOL_INPUT_SCHEMAS

        schema = TOOL_INPUT_SCHEMAS.get(tool_name)
        if schema is None or not isinstance(raw_args, dict):
            return {}
        try:
            return schema.model_validate(raw_args).model_dump(
                exclude_none=True,
                exclude_unset=True,
            )
        except (TypeError, ValueError):
            return {}

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
                            raw_name = field.get("name")
                            raw_status = field.get("status")
                            raw_reason = field.get("reason")
                            safe_fields.append(
                                {
                                    "name": str(raw_name) if raw_name is not None else "",
                                    "status": str(raw_status) if raw_status is not None else "",
                                    "reason": str(raw_reason) if raw_reason is not None else None,
                                }
                            )
                    safe_sections.append(
                        {
                            "name": str(section.get("name") or ""),
                            "fields": safe_fields,
                        }
                    )
            passenger_type = passenger.get("passengerType")
            passenger_ordinal = passenger.get("passengerOrdinal")
            safe_passengers.append(
                {
                    "passengerType": str(passenger_type) if passenger_type is not None else "",
                    "passengerOrdinal": (
                        int(passenger_ordinal) if isinstance(passenger_ordinal, int) else 1
                    ),
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
        summary_str = (
            validated_result
            if isinstance(validated_result, str)
            else json.dumps(validated_result, ensure_ascii=False)
            if isinstance(validated_result, dict)
            else "Tool completed safely."
        )

        if tool_name == "check_booking_readiness":
            output_data: object = validated_result
            if isinstance(output_data, str):
                try:
                    output_data = json.loads(output_data)
                except (json.JSONDecodeError, TypeError, ValueError):
                    return ToolResolution(
                        is_blocked=True,
                        error_code="READINESS_RESPONSE_INVALID",
                        error_message="Booking readiness could not be verified safely.",
                    )

            if not isinstance(output_data, dict) or "error" in output_data:
                return ToolResolution(
                    is_blocked=True,
                    error_code="READINESS_RESPONSE_INVALID",
                    error_message="Booking readiness could not be verified safely.",
                )

            safe_readiness = validate_booking_readiness_response(output_data)
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

            def _get_ctx(key: str, default: object = None) -> object:
                if isinstance(context, dict):
                    return context.get(key, default)
                return getattr(context, key, default)

            lifecycle = self.snapshot_lifecycle or _get_ctx("snapshot_lifecycle")
            if lifecycle is None:
                repo = _get_ctx("snapshot_repository")
                redis_client = _get_ctx("redis_client")
                if repo is not None:
                    lifecycle = TrustedSearchSnapshotLifecycle(repo)
                elif redis_client is not None:
                    lifecycle = TrustedSearchSnapshotLifecycle(
                        TrustedSnapshotRepository(redis_client)
                    )

            user_id = str(_get_ctx("user_id", "") or "")
            session_id = str(_get_ctx("session_id", _get_ctx("chat_session_id", "")) or "")

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
                                summary_override=summary_str,
                                follow_up_event=FlightResultsEvent(
                                    data=FlightResultsPayload(results=raw_results)
                                ),
                            )
                except Exception:
                    logger.warning("search_result_projection_failed", exc_info=True)

            return ToolResolution(
                is_blocked=False,
                summary_override=summary_str,
                follow_up_event=None,
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

        output = node_output if isinstance(node_output, dict) else {}
        action_res = (
            output.get("action")
            if isinstance(output, dict) and isinstance(output.get("action"), dict)
            else {}
        )

        if isinstance(action_res, dict) and "error" in action_res:
            err_msg = str(action_res.get("error") or "Checkout handoff could not be created.")
            return HandoffResolution(
                is_blocked=True,
                error_code="HANDOFF_FAILED",
                error_message="Checkout handoff could not be created.",
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
