from langchain_core.runnables import RunnableConfig
from agent.tools.nestjs_client import NestJSClient

def get_nestjs_client(config: RunnableConfig) -> NestJSClient:
    """Extract NestJSClient from RunnableConfig's configurable key."""
    if config is None:
        raise ValueError("RunnableConfig is missing or None.")
    
    if "configurable" not in config:
        raise ValueError("RunnableConfig is missing 'configurable' key.")
    
    configurable = config["configurable"]
    if not configurable or "nestjs_client" not in configurable:
        raise ValueError("NestJSClient not found in RunnableConfig's 'configurable' key.")
    
    client = configurable.get("nestjs_client")
    if not client:
        raise ValueError("NestJSClient not found in RunnableConfig's 'configurable' key.")
    
    return client
