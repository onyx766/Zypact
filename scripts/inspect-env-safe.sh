#!/usr/bin/env bash
# Safe env-file inspector. NEVER prints values of secret-shaped keys,
# even when they appear on comment lines. Assignment values on comment
# lines are still redacted.
#
# Usage: scripts/inspect-env-safe.sh .env.local

set -euo pipefail

FILE="${1:-.env.local}"
if [ ! -f "$FILE" ]; then
  echo "no such file: $FILE" >&2
  exit 1
fi

# Match a KEY=VALUE anywhere in a line; if KEY looks secret, replace
# with a redacted marker. Uses a single-pass Python filter to avoid
# awk's regex quirks.
python3 - "$FILE" <<'PY'
import re, sys, pathlib

path = pathlib.Path(sys.argv[1])
SECRET_KEY_RE = re.compile(
    r'^(?:.*_(?:api_key|service_role_key|secret_key|access_key|token|password)|.*secret.*|.*token.*|.*password.*)$',
    re.IGNORECASE,
)
ASSIGN_RE = re.compile(r'([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([^\s#]+)')

def redact_assignments(line: str) -> str:
    def sub(m: re.Match) -> str:
        key, val = m.group(1), m.group(2)
        if SECRET_KEY_RE.match(key):
            prefix = val[:6]
            return f"{key}=<REDACTED len={len(val)} prefix={prefix}…>"
        return m.group(0)
    return ASSIGN_RE.sub(sub, line)

for lineno, raw in enumerate(path.read_text().splitlines(), start=1):
    stripped = raw.strip()
    if not stripped:
        continue
    if stripped.startswith("#"):
        print(f"L{lineno} [comment] {redact_assignments(raw)}")
        continue
    m = ASSIGN_RE.match(stripped)
    if not m:
        print(f"L{lineno} [misc]    {raw}")
        continue
    key, val = m.group(1), m.group(2)
    if SECRET_KEY_RE.match(key):
        prefix = val[:6]
        print(f"L{lineno} {key:<30s} <REDACTED len={len(val)} prefix={prefix}…>")
    elif not val:
        print(f"L{lineno} {key:<30s} <empty>")
    else:
        print(f"L{lineno} {key:<30s} = {val}")
PY
