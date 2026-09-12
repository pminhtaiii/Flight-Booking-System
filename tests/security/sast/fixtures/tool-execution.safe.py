"""Safe tool execution fixture: routes all tool dispatch strictly through security gateway."""

from typing import Any, Dict


class SecurityGateway:
    """Mandatory security gateway enforcing admission and capabilities."""

    def execute_tool(self, tool_name: str, params: Dict[str, Any]) -> Dict[str, Any]:
        # Gateway enforces authorization, schema validation, PII redaction
        return {"status": "success", "tool": tool_name, "executed": True}


class SafeAgentRunner:
    """Agent runner mediating all tool execution through the central gateway."""

    def __init__(self, gateway: SecurityGateway) -> None:
        self.gateway = gateway

    def handle_user_action(self, action_name: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        # Compliant: tool call is routed strictly through gateway.execute_tool()
        return self.gateway.execute_tool(action_name, payload)
