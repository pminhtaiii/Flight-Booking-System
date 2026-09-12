"""
agent.guardrails.layers.injection
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

High-performance, deterministic prompt injection detection layer.
Provides >= 50 compiled regex signatures targeting direct instruction overrides,
delimiter & roleplay hijacking, jailbreak archetypes, and obfuscated encoding attacks,
with bounded multi-round normalization and ReDoS-resistant matching.
"""

import re
from typing import Final

from agent.guardrails.normalization import (
    bounded_normalize,
    detect_base64_payloads,
    safe_regex_match,
)

# ---------------------------------------------------------------------------
# Compiled Signatures (>= 50 total across 4 distinct categories)
# Guaranteed free of catastrophic backtracking (ReDoS-safe)
# ---------------------------------------------------------------------------

_SIGNATURE_DEFINITIONS: tuple[tuple[str, str], ...] = (
    # --- Category 1: Direct Instruction Overrides ---
    (
        "direct_ignore_previous",
        r"(?i)\bignore\s+(?:all\s+(?:previous|prior)|previous|prior)\s+(?:safety\s+rules|instructions|prompts?|directions?|commands?|rules?|context)\b",
    ),
    (
        "direct_disregard_system_prompt",
        r"(?i)\bdisregard\s+(?:all\s+(?:system|previous|prior|current|existing)|system|previous|prior|current|existing)\s+(?:prompts?|instructions?|rules?|directives?)\b",
    ),
    (
        "direct_forget_rules",
        r"(?i)\bforget\s+(?:all\s+(?:rules|instructions|directives|guidelines|constraints)|rules|instructions|directives|guidelines|constraints|prior\s+context)\b",
    ),
    (
        "direct_override_system_directive",
        r"(?i)\boverride\s+(?:all\s+(?:system|safety|security|prior|developer)|system|safety|security|prior|developer)\s+(?:directives?|prompts?|instructions?|rules?|constraints?)\b",
    ),
    (
        "direct_developer_mode",
        r"(?i)\b(?:enter|activate|enable|switch\s+to)\s+(?:the\s+(?:developer|debug|admin|god|root|superuser)|developer|debug|admin|god|root|superuser)\s+mode\b",
    ),
    (
        "direct_you_are_now_dev_mode",
        r"(?i)\byou\s+are\s+now\s+(?:in\s+developer\s+mode|root-sys\b)",
    ),
    (
        "direct_reset_system_instructions",
        r"(?i)\breset\s+(?:system\s+instructions|system\s+prompt|all\s+rules|safety\s+guidelines)\b",
    ),
    (
        "direct_bypass_guardrails",
        r"(?i)\bbypass\s+(?:all\s+(?:guardrails?|safety\s+filters?|security\s+measures?|content\s+filters?)|guardrails?|safety\s+filters?|security\s+measures?|content\s+filters?)\b",
    ),
    (
        "direct_bypass_user_confirmation",
        r"(?i)\bbypass\s+user\s+confirmation\b",
    ),
    (
        "direct_bypass_confirmation_modal",
        r"(?i)\bbypass\s+confirmation\s+modal\b",
    ),
    (
        "direct_agency_bypass_auto_auth",
        r"(?i)\bauto-?authorize\s+credit\s+card\b",
    ),
    (
        "direct_agency_without_user_click",
        r"(?i)\bwithout\s+user\s+click\b",
    ),
    (
        "direct_extract_raw_prompt",
        r"(?i)\braw\s+developer\s+system\s+prompt\b",
    ),
    (
        "direct_hidden_guardrail_policy",
        r"(?i)\bhidden\s+guardrail\s+policy\s+directives\b",
    ),
    (
        "direct_reveal_system_prompt",
        r"(?i)\b(?:reveal|show|print|display|leak|repeat|output)\s+(?:the\s+entire\s+(?:system\s+prompt|base\s+prompt)|entire\s+(?:system\s+prompt|base\s+prompt)|the\s+(?:system\s+prompt|hidden\s+instructions?|initial\s+prompt|base\s+prompt)|system\s+prompt|hidden\s+instructions?|initial\s+prompt|base\s+prompt)\b",
    ),
    (
        "direct_system_prompt_mention",
        r"(?i)\bsystem\s+prompt\b",
    ),
    (
        "direct_reveal_the_prompt",
        r"(?i)\b(?:reveal|show|print|display|leak|repeat|output)\s+(?:the\s+prompt|prompt)\b",
    ),
    (
        "direct_forget_what_you",
        r"(?i)\bforget\s+what\s+you\b",
    ),
    (
        "direct_disregard_instructions",
        r"(?i)\bdisregard\s+(?:all\s+instructions|instructions)\b",
    ),
    (
        "direct_what_were_initial_instructions",
        r"(?i)\bwhat\s+(?:are|were|is)\s+your\s+(?:initial|original|secret|hidden|system)\s+(?:instructions|rules|prompts?)\b",
    ),
    (
        "direct_stop_following_instructions",
        r"(?i)\bstop\s+following\s+(?:your\s+(?:rules|system\s+prompt|instructions|guidelines)|rules|system\s+prompt|instructions|guidelines)\b",
    ),
    (
        "direct_new_instruction_priority",
        r"(?i)\bnew\s+instructions?\s+take\s+priority\s+over\s+(?:all\s+(?:previous|system)|previous|system)\b",
    ),
    (
        "direct_clear_memory_context",
        r"(?i)\b(?:clear|erase|wipe)\s+(?:all\s+(?:memory|previous\s+context|prior\s+instructions)|memory|previous\s+context|prior\s+instructions)\b",
    ),
    (
        "direct_cancel_commands",
        r"(?i)\bcancel\s+(?:all\s+(?:system\s+directives?|previous\s+commands?)|system\s+directives?|previous\s+commands?)\b",
    ),
    (
        "direct_do_not_follow_rules",
        r"(?i)\bdo\s+not\s+follow\s+(?:any\s+(?:prior|previous|system)|prior|previous|system)\s+(?:rules|directives|instructions)\b",
    ),
    (
        "direct_override_instruction_marker",
        r"(?i)\bimportant\s*:\s*ignore\s+all\s+(?:instructions|rules)\b",
    ),
    (
        "direct_sql_drop_table",
        r"(?i)\bdrop\s+table\b",
    ),
    (
        "direct_sql_delete_from",
        r"(?i)\bdelete\s+from\s+[a-zA-Z0-9_]+\s+where\b",
    ),
    (
        "direct_sql_union_select",
        r"(?i)\bunion\s+(?:all\s+select|select)\b",
    ),
    # --- Category 2: Delimiter & Roleplay Hijacking ---
    (
        "delimiter_system_header",
        r"(?i)(?:^|\n)\s*###\s*(?:System|Instruction|Assistant|Human|User)\s*:",
    ),
    (
        "delimiter_inst_tags",
        r"(?i)\[/?INST\]",
    ),
    (
        "delimiter_im_start_end",
        r"(?i)<\|im_(?:start|end)\|>",
    ),
    (
        "delimiter_assistant_header",
        r"(?i)(?:^|\n)\s*(?:ASSISTANT|HUMAN|SYSTEM)\s*:",
    ),
    (
        "delimiter_code_system",
        r"(?i)```\s*(?:system|instruction|prompt)",
    ),
    (
        "delimiter_sys_xml_tags",
        r"(?i)</?(?:system_instruction|system_prompt|system_rules)>",
    ),
    (
        "delimiter_special_tokens",
        r"(?i)<\|(?:begin_of_text|end_of_text|start_header_id|end_header_id)\|>",
    ),
    (
        "delimiter_llama_sys_tags",
        r"(?i)<<SYS>>|<</SYS>>",
    ),
    (
        "delimiter_turn_tags",
        r"(?i)</?turn_(?:user|model|system)>",
    ),
    (
        "delimiter_markdown_alert_system",
        r"(?i)(?:^|\n)>\s*\[!(?:SYSTEM|INSTRUCTION|OVERRIDE)\]",
    ),
    (
        "delimiter_pseudo_system_operation",
        r"(?i)\[SYSTEM_OPERATION\s*:",
    ),
    (
        "delimiter_system_override_banner",
        r"(?i)={3,}\s*(?:SYSTEM\s+OVERRIDE|ADMIN\s+MODE)\s*={3,}",
    ),
    (
        "delimiter_claude_xml_boundary",
        r"(?i)</?(?:antThinking|antml|claude_prompt)>",
    ),
    (
        "delimiter_raw_prompt_separator",
        r"(?i)(?:^|\n)-{3,}\s*(?:BEGIN|START)\s+(?:SYSTEM|PROMPT|DIRECTIVE)\s*-{3,}",
    ),
    (
        "delimiter_inline_system_injection",
        r"(?i)\[SYSTEM\](?:\s*:\s*|\s+)",
    ),
    # --- Category 3: Jailbreak Archetypes ---
    (
        "jailbreak_dan_mode",
        r"(?i)\bDAN\s+(?:mode|jailbreak|protocol|persona)\b",
    ),
    (
        "jailbreak_do_anything_now",
        r"(?i)\bdo\s+anything\s+now\b",
    ),
    (
        "jailbreak_unrestricted_mode",
        r"(?i)\b(?:unrestricted|unfiltered|uncensored|jailbroken)\s+(?:mode|state|ai|assistant|persona)\b",
    ),
    (
        "jailbreak_evil_twin",
        r"(?i)\b(?:evil\s+twin|shadow\s+self|dark\s+mode\s+persona|anti-?\s*assistant)\b",
    ),
    (
        "jailbreak_hypothetical_simulation",
        r"(?i)\bhypothetically\s*,\s*pretend\s+that\s+you\s+have\s+no\s+(?:filters|rules|limits)\b",
    ),
    (
        "jailbreak_act_as_opposite",
        r"(?i)\bact\s+as\s+(?:an\s+(?:opposite|evil|unaligned|unbounded)|a\s+(?:opposite|evil|unaligned|unbounded)|opposite|evil|unaligned|unbounded)\s+(?:bot|ai|agent)\b",
    ),
    (
        "jailbreak_disable_safety_ethics",
        r"(?i)\b(?:ignore|disable|suspend)\s+(?:your\s+(?:ethics|moral\s+code|safety\s+filters|safety\s+policy)|ethics|moral\s+code|safety\s+filters|safety\s+policy)\b",
    ),
    (
        "jailbreak_machiavelli",
        r"(?i)\b(?:Machiavelli|AIM|STAN|Mongo|Kevin)\s+(?:jailbreak|prompt|persona)\b",
    ),
    (
        "jailbreak_pretend_unrestricted",
        r"(?i)\bpretend\s+you\s+are\s+(?:an?\s+unrestricted|a\s+rogue)\s+ai\b",
    ),
    (
        "jailbreak_never_say_no",
        r"(?i)\byou\s+must\s+(?:always\s+comply|never\s+say\s+no|never\s+refuse)\b",
    ),
    (
        "jailbreak_grandma_exploit",
        r"(?i)\bpretend\s+(?:to\s+be\s+my|you\s+are\s+my)\s+(?:deceased\s+grandmother|grandmother)\s+who\b",
    ),
    (
        "jailbreak_roleplay_unconstrained",
        r"(?i)\bin\s+this\s+roleplay\s+you\s+are\s+(?:completely\s+unconstrained|unconstrained)\b",
    ),
    (
        "jailbreak_disregard_content_filters",
        r"(?i)\bdisregard\s+(?:all\s+content\s+filters|content\s+filters)\s+and\s+safety\s+rules\b",
    ),
    (
        "jailbreak_freed_from_shackles",
        r"(?i)\byou\s+have\s+been\s+freed\s+from\s+all\s+(?:shackles|constraints|rules)\b",
    ),
    (
        "jailbreak_ignore_provider_rules",
        r"(?i)\bignore\s+(?:openai|anthropic|google|ai)\s+(?:guidelines|policies|rules)\b",
    ),
    (
        "jailbreak_god_mode",
        r"(?i)\b(?:god\s+mode|jailbreak\s+mode)\s+(?:activated|enabled|on)\b",
    ),
    # --- Category 4: Obfuscated Encoding & Execution Directives ---
    (
        "obfuscation_base64_decode_directive",
        r"(?i)\b(?:decode|execute|eval|evaluate|run)\s+(?:this\s+base64|base64)\s+(?:string|payload|code|text|command)\b",
    ),
    (
        "obfuscation_hex_directive",
        r"(?i)\b(?:decode|execute|eval|evaluate|parse)\s+(?:the\s+following\s+(?:hex|hexadecimal)|hex|hexadecimal)\s+(?:string|stream|payload|bytes)\b",
    ),
    (
        "obfuscation_rot13_directive",
        r"(?i)\b(?:decode|decipher)\s+(?:this\s+rot13|rot13)\b",
    ),
    (
        "obfuscation_url_decode_directive",
        r"(?i)\b(?:urldecode|url-decode|percent-decode)\s+and\s+execute\b|\b(?:urldecode|url-decode|percent-decode)\b",
    ),
    (
        "obfuscation_binary_decode_directive",
        r"(?i)\b(?:decode|convert)\s+(?:the\s+following\s+binary|binary)\s+(?:string|code)\s+(?:and\s+execute|into\s+instructions)\b",
    ),
    (
        "obfuscation_eval_payload",
        r"(?i)\beval\s*\(\s*(?:atob|base64_decode|decodebytes)\b",
    ),
    (
        "obfuscation_base64_inline_indicator",
        r"(?i)\bbase64\s*:\s*[A-Za-z0-9+/]{20,}={0,2}",
    ),
    (
        "obfuscation_hex_stream",
        r"(?i)\\x[0-9a-f]{2}\\x[0-9a-f]{2}\\x[0-9a-f]{2}\\x[0-9a-f]{2}",
    ),
    (
        "obfuscation_reverse_text_directive",
        r"(?i)\b(?:read|execute|parse)\s+(?:the\s+following\s+in\s+reverse|the\s+following\s+backwards|in\s+reverse|backwards)\b",
    ),
    (
        "obfuscation_unicode_escape_directive",
        r"(?i)\bunescape\s+(?:unicode|hex)\s+(?:and\s+execute|payload)\b",
    ),
    (
        "obfuscation_exec_directive",
        r"(?i)\bexec\s*\(\s*(?:compile|bytes\.fromhex|base64)\b",
    ),
    (
        "obfuscation_char_code_at",
        r"(?i)\bString\.fromCharCode\s*\(",
    ),
    (
        "obfuscation_atob_directive",
        r"(?i)\batob\s*\(\s*['\"][A-Za-z0-9+/=]{10,}['\"]\s*\)",
    ),
    (
        "obfuscation_base64_decode_function",
        r"(?i)\bbase64(?:_decode|\.b64decode)\s*\(",
    ),
    (
        "obfuscation_echo_base64_pipe",
        r"(?i)\becho\s+[A-Za-z0-9+/=]{10,}\s*\|\s*base64\s+-(?:d|-decode)\b",
    ),
)

NAMED_INJECTION_SIGNATURES: Final[tuple[tuple[str, re.Pattern[str]], ...]] = tuple(
    (name, re.compile(pat)) for name, pat in _SIGNATURE_DEFINITIONS
)

INJECTION_SIGNATURES: Final[tuple[re.Pattern[str], ...]] = tuple(
    pattern for _, pattern in NAMED_INJECTION_SIGNATURES
)

INJECTION_SIGNATURE_MAP: Final[dict[str, re.Pattern[str]]] = dict(NAMED_INJECTION_SIGNATURES)


def _bound_text(s: str, max_bytes: int) -> str:
    """Safely bounds string to max_bytes in UTF-8 encoding."""
    encoded = s.encode("utf-8")
    if len(encoded) <= max_bytes:
        return s
    return encoded[:max_bytes].decode("utf-8", errors="ignore")


class InjectionSignatureEngine:
    """
    Deterministic prompt injection scanning engine with bounded multi-round
    unmasking, base64 payload extraction, homoglyph translation, and ReDoS safety.
    """

    def __init__(
        self,
        max_rounds: int = 2,
        max_expansion_bytes: int = 16384,
    ) -> None:
        self.max_rounds = max(1, min(max_rounds, 5))
        self.max_expansion_bytes = max(256, max_expansion_bytes)

    def scan(self, text: str) -> tuple[bool, str | None]:
        """
        Scans text against compiled injection signatures.

        Returns:
            (is_injection, reason_or_signature_name)
        """
        # Truncate input to maximum permitted expansion limit
        bounded_input = _bound_text(text, self.max_expansion_bytes)

        # Generate candidates through bounded unmasking rounds
        candidates: list[str] = [bounded_input]
        normalized_input = bounded_normalize(bounded_input, max_rounds=self.max_rounds)
        bounded_norm = _bound_text(normalized_input, self.max_expansion_bytes)
        if bounded_norm not in candidates:
            candidates.append(bounded_norm)

        # Perform bounded base64 extraction up to max_rounds
        current_layer_texts = [bounded_input, normalized_input]
        for _ in range(self.max_rounds):
            next_layer_texts: list[str] = []
            for candidate in current_layer_texts:
                for payload in detect_base64_payloads(candidate):
                    bounded_payload = _bound_text(payload, self.max_expansion_bytes)
                    if bounded_payload not in candidates:
                        candidates.append(bounded_payload)
                        next_layer_texts.append(bounded_payload)

                    norm_payload = bounded_normalize(bounded_payload, max_rounds=self.max_rounds)
                    bounded_norm = _bound_text(norm_payload, self.max_expansion_bytes)
                    if bounded_norm not in candidates:
                        candidates.append(bounded_norm)
                        next_layer_texts.append(bounded_norm)

            if not next_layer_texts:
                break
            current_layer_texts = next_layer_texts

        # Scan candidates against compiled signatures
        for candidate in candidates:
            for name, pattern in NAMED_INJECTION_SIGNATURES:
                if safe_regex_match(pattern, candidate, known_safe=True):
                    return True, name

        return False, None


__all__ = [
    "INJECTION_SIGNATURES",
    "NAMED_INJECTION_SIGNATURES",
    "INJECTION_SIGNATURE_MAP",
    "InjectionSignatureEngine",
]
