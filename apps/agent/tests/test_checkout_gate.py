import pytest
from langchain_core.messages import HumanMessage

from agent.graph.checkout_gate import evaluate_checkout_gate
from agent.graph.state import AgentState
from agent.models.requests import RouteDecision


def test_checkout_gate_success():
    state = AgentState(
        messages=[HumanMessage(content="Book the first one")],
        trusted_snapshot={"results": [{}, {}]},  # Has results
    )
    decision = RouteDecision(intent="CHECKOUT", confidence=0.8, isCommitment=True, selectionIndex=1)

    result = evaluate_checkout_gate(state, decision)
    assert result["route"] == "checkout"
    assert result["disambiguation"] == "none"


@pytest.mark.parametrize(
    "decision_args, state_update, expected_disambiguation",
    [
        (
            {"intent": "CHECKOUT", "confidence": 0.6, "isCommitment": True, "selectionIndex": 1},
            {"trusted_snapshot": {"results": [{}, {}]}},
            "possible_checkout",  # fails confidence threshold 0.7
        ),
        (
            {"intent": "CHECKOUT", "confidence": 0.8, "isCommitment": False, "selectionIndex": 1},
            {"trusted_snapshot": {"results": [{}, {}]}},
            "possible_checkout",  # fails commitment
        ),
        (
            {"intent": "CHECKOUT", "confidence": 0.8, "isCommitment": True, "selectionIndex": 1},
            {"trusted_snapshot": None},  # missing
            "possible_checkout",
        ),
        (
            {"intent": "CHECKOUT", "confidence": 0.8, "isCommitment": True, "selectionIndex": 3},
            {"trusted_snapshot": {"results": [{}, {}]}},  # index out of bounds
            "possible_checkout",
        ),
        (
            {"intent": "CHECKOUT", "confidence": 0.8, "isCommitment": True, "selectionIndex": None},
            {"trusted_snapshot": {"results": [{}, {}]}},  # missing index
            "possible_checkout",
        ),
    ],
)
def test_checkout_gate_incomplete(decision_args, state_update, expected_disambiguation):
    state = AgentState(messages=[HumanMessage(content="Book the flight")], **state_update)
    decision = RouteDecision(**decision_args)

    result = evaluate_checkout_gate(state, decision)
    assert result["route"] == "travel"
    assert result["disambiguation"] == expected_disambiguation


def test_checkout_gate_non_checkout_intent():
    state = AgentState(messages=[HumanMessage(content="Hello")], trusted_snapshot=None)
    decision = RouteDecision(
        intent="GENERAL", confidence=0.9, isCommitment=False, selectionIndex=None
    )
    result = evaluate_checkout_gate(state, decision)
    assert result["route"] == "general"
    assert result["disambiguation"] == "none"


def test_checkout_gate_search_intent():
    state = AgentState(messages=[HumanMessage(content="Find flights")], trusted_snapshot=None)
    decision = RouteDecision(
        intent="SEARCH", confidence=0.9, isCommitment=False, selectionIndex=None
    )
    result = evaluate_checkout_gate(state, decision)
    assert result["route"] == "travel"
    assert result["disambiguation"] == "none"
