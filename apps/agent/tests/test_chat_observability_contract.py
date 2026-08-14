from agent.observability.chat_observability import dashboard_alert_contract


def test_dashboard_alert_contract_separates_emitted_signals_from_pending_panels():
    assert dashboard_alert_contract() == {
        "emitted_operations": (
            "handoff_create", "quota_admission", "router_decision", "snapshot_read",
            "tool_call",
        ),
        "emitted_fields": (
            "confidence_bucket", "dependency", "error_class", "intent", "outcome",
            "tool_name",
        ),
        "allowed_but_not_yet_emitted_capabilities": {
            "operations": ("handoff_consume", "handoff_replay", "handoff_resolve"),
            "fields": (
                "handoff_state", "result_count", "route", "snapshot_state",
                "snapshot_version", "specialist",
            ),
        },
        "required_but_not_yet_emitted_panels": (
            "active_streams", "daily_quota_utilization_buckets", "disambiguations",
            "handoff_expired", "handoff_foreign", "handoff_stale", "redis_latency",
            "snapshot_expire", "snapshot_replace", "stream_time_to_first_safe_token",
        ),
        "alert_thresholds": {
            "error_rate": {"baseline_multiplier": 2, "window_minutes": 5},
            "handoff_consume_p95_ms": 300,
            "handoff_resolve_p95_ms": 300,
        },
        "performance_gates": {"router_overhead_p95_ms_under": 100},
        "forbidden_field_names": (
            "authorization", "booking_db_id", "contact_data", "duffel_offer_id",
            "handoff_token", "handoff_token_hash", "local_offer_id", "message_content",
            "passenger_data", "passport_data", "payment_data", "pnr", "raw_tool_payload",
            "secret", "session_id", "summary_content", "url", "user_id",
        ),
        "forbidden_value_markers": (
            "authorization", "booking_db_id", "contact", "duffel_offer_id", "handoff_token",
            "handoff_token_hash", "local_offer_id", "message", "passenger", "passport",
            "payment", "pnr", "raw_tool_payload", "secret", "summary", "token",
        ),
    }


def test_dashboard_alert_contract_protects_identity_and_secret_surfaces():
    contract = dashboard_alert_contract()

    assert contract["forbidden_field_names"] == tuple(sorted((
        "authorization", "booking_db_id", "contact_data", "duffel_offer_id", "handoff_token",
        "handoff_token_hash", "local_offer_id", "message_content", "passenger_data",
        "passport_data", "payment_data", "pnr", "raw_tool_payload", "secret", "session_id",
        "summary_content", "url", "user_id",
    )))
    assert contract["forbidden_value_markers"] == (
        "authorization", "booking_db_id", "contact", "duffel_offer_id", "handoff_token",
        "handoff_token_hash", "local_offer_id", "message", "passenger", "passport", "payment",
        "pnr", "raw_tool_payload", "secret", "summary", "token",
    )
