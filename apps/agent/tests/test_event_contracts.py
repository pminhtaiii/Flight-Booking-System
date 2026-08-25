import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from agent.models.events import HandoffEvent


@pytest.fixture
def chat_events_fixtures():
    fixture_path = Path(__file__).parent / "fixtures" / "chat_events.json"
    with fixture_path.open() as f:
        return json.load(f)


def test_accepts_valid_handoff_event(chat_events_fixtures):
    data = chat_events_fixtures["valid_handoff_event"]
    event = HandoffEvent(**data)
    assert event.action == "begin_checkout"
    assert event.handoffToken is not None


def test_rejects_handoff_event_missing_token(chat_events_fixtures):
    data = chat_events_fixtures["invalid_handoff_event_missing_token"]
    with pytest.raises(ValidationError):
        HandoffEvent(**data)


def test_rejects_handoff_event_extra_fields(chat_events_fixtures):
    data = chat_events_fixtures["invalid_handoff_event_extra_fields"]
    with pytest.raises(ValidationError):
        HandoffEvent(**data)
