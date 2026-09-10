"""Safe dynamic imports fixture: uses static explicit registry mapping and factories."""

from typing import Callable, Mapping


class BaseHandler:
    def process(self, data: str) -> str:
        return data


class SearchHandler(BaseHandler):
    def process(self, data: str) -> str:
        return f"search: {data}"


class BookingHandler(BaseHandler):
    def process(self, data: str) -> str:
        return f"booking: {data}"


# Compliant: Static dictionary mapping with explicit factory Callables
HANDLER_REGISTRY: Mapping[str, Callable[[], BaseHandler]] = {
    "search": SearchHandler,
    "booking": BookingHandler,
}


def resolve_handler(handler_name: str) -> BaseHandler:
    """Resolve handler through explicit static registry lookup."""
    factory = HANDLER_REGISTRY.get(handler_name)
    if not factory:
        raise ValueError(f"Unknown handler type: {handler_name}")
    return factory()
