import asyncio
from typing import Annotated

from langchain_core.messages import AIMessage, ToolMessage
from langchain_core.tools import InjectedToolCallId, tool
from langgraph.prebuilt import InjectedState, ToolNode
from langgraph.types import Command


@tool
def my_tool(
    offer_index: int,
    tool_call_id: Annotated[str, InjectedToolCallId],
    state: Annotated[dict, InjectedState],
) -> Command:
    """My tool"""
    return Command(
        update={
            "signal": {"intent": "checkout", "offer_index": offer_index},
            "messages": [ToolMessage("Done", tool_call_id=tool_call_id)],
        }
    )


async def main():
    node = ToolNode([my_tool])
    state = {
        "messages": [
            AIMessage(
                content="",
                tool_calls=[{"name": "my_tool", "args": {"offer_index": 1}, "id": "call_1"}],
            )
        ]
    }
    result = await node.ainvoke(state)
    print("TYPE:", type(result))
    print("RESULT:", result)


asyncio.run(main())
