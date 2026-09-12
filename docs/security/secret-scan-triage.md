# Secret scan triage

Synthetic credentials used by security fixtures and local configuration examples
are allowlisted only by their exact value, matching rule, and repository-relative
file path in `.gitleaks.toml`. Gitleaks default rules remain active for every
other value and path. A value that resembles a real credential in an allowlisted
file must remain detectable unless it exactly matches the reviewed fixture value.
