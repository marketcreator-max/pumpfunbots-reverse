#!/usr/bin/env python3
"""Strip exported RPC URLs and API keys from a paper-run log. Reads env itself."""

import os
import re
import sys

SECRETS = (
    "RPC_URL",
    "WS_URL",
    "HELIUS_API_KEY",
    "HELIUS_RPC_URL",
    "ALCHEMY_API_KEY",
    "ALCHEMY_RPC_URL",
    "ALCHEMY_URL",
    "ALCHEMY_SOLANA_URL",
)
secrets = [os.environ[k] for k in SECRETS if len(os.environ.get(k) or "") >= 8]
secrets.sort(key=len, reverse=True)
pat = re.compile(r"(api-key=|api_key=)[^&\s\"']+", re.I)
pat2 = re.compile(r"(https://solana-mainnet\.g\.alchemy\.com/v2/)[^/\s\"']+", re.I)

for line in sys.stdin:
    for secret in secrets:
        if secret in line:
            line = line.replace(secret, "REDACTED")
    line = pat.sub(lambda m: m.group(1) + "REDACTED", line)
    line = pat2.sub(lambda m: m.group(1) + "REDACTED", line)
    sys.stdout.write(line)
    sys.stdout.flush()
