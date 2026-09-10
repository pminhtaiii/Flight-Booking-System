"""Unsafe dynamic imports fixture: uses dynamic loading and code execution sinks."""

import importlib
from typing import Any


def load_plugin_dynamic(module_path: str, class_name: str) -> Any:
    # VIOLATION: Dynamic import via importlib
    mod = importlib.import_module(module_path)
    return getattr(mod, class_name)()


def load_legacy_module(name: str) -> Any:
    # VIOLATION: Dynamic import via __import__
    return __import__(name)


def execute_dynamic_snippet(code: str, context: dict[str, Any]) -> Any:
    # VIOLATION: eval execution
    return eval(code, context)


def run_dynamic_script(code_str: str) -> None:
    # VIOLATION: exec execution
    exec(code_str)
