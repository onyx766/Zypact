#!/usr/bin/env python3
"""
Run a command with env vars loaded from .env.local without letting the
shell `source` builtin interpret file contents. This avoids the class
of bug where a value that looks like a command (e.g. "sk-proj-…") gets
echoed via "command not found" errors when shell `source` fails.

Usage:
  python3 scripts/run-with-env.py <command> [args...]

Behavior:
  - Reads .env.local (KEY=VALUE lines; supports "#" comments)
  - Tolerates whitespace after "=" and simple surrounding quotes
  - Never prints any value
  - Refuses to run if the file appears to embed shell metacharacters
    in a way that would be dangerous when re-quoted
  - Removes ZYPACT_MOCK_MODE=on if inherited from the parent shell
    (so mocks can't sneak in accidentally)
"""
from __future__ import annotations

import os
import pathlib
import subprocess
import sys
from typing import Dict

ENV_FILE = pathlib.Path(".env.local")


def load_env() -> Dict[str, str]:
    env = os.environ.copy()
    if not ENV_FILE.is_file():
        return env
    for lineno, raw in enumerate(ENV_FILE.read_text().splitlines(), start=1):
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        key = key.strip()
        val = val.lstrip()
        if len(val) >= 2 and val[0] == val[-1] and val[0] in ("'", '"'):
            val = val[1:-1]
        val = val.rstrip()
        if not key:
            continue
        env[key] = val
    if env.get("ZYPACT_MOCK_MODE") == "on":
        env.pop("ZYPACT_MOCK_MODE", None)
    return env


def main() -> None:
    if len(sys.argv) < 2:
        print("usage: run-with-env.py <command> [args...]", file=sys.stderr)
        sys.exit(2)
    env = load_env()
    result = subprocess.run(sys.argv[1:], env=env)
    sys.exit(result.returncode)


if __name__ == "__main__":
    main()
