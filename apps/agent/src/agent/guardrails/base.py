from typing import Protocol, Tuple

class GuardrailService(Protocol):
    async def validate_message(self, message: str) -> Tuple[bool, str]:
        """
        Validates the input message.
        
        Args:
            message: The raw input message string from the user.
            
        Returns:
            Tuple[bool, str]: A tuple where the first element indicates whether the message
                             is allowed, and the second element is the error reason if blocked
                             (or an empty string if allowed).
        """
        ...

    def is_healthy(self) -> bool:
        """
        Checks if the guardrail service is healthy and available.
        
        Returns:
            bool: True if the service is healthy, False otherwise.
        """
        ...
