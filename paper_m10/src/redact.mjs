const SECRET_ENV = [
  "RPC_URL",
  "WS_URL",
  "HELIUS_API_KEY",
  "HELIUS_RPC_URL",
  "ALCHEMY_API_KEY",
  "ALCHEMY_KEY",
  "ALCHEMY_RPC_URL",
  "ALCHEMY_URL",
  "ALCHEMY_SOLANA_URL",
  "ALCHEMY_RH_RPC_URL",
  "HOOD_RPC_URL",
  "HOOD_WS_URL",
];

export function envSecrets() {
  const out = [];
  for (const key of SECRET_ENV) {
    const value = process.env[key];
    if (value && value.length >= 8) out.push(value);
  }
  return out;
}

// Strip endpoint credentials from anything that might be logged.
export function redact(input, secrets = envSecrets()) {
  let text = String(input);
  text = text.replace(/(api-key=|api_key=|apiKey=)[^&\s"'<>]+/gi, "$1REDACTED");
  const list = [...secrets].filter((s) => s && s.length >= 8).sort((a, b) => b.length - a.length);
  for (const secret of list) text = text.split(secret).join("REDACTED");
  return text;
}

export function createLogger(stream = process.stdout, extras = {}) {
  const write = (level, args) => {
    const parts = args.map((part) => {
      if (typeof part === "string") return part;
      if (part instanceof Error) return part.message;
      try {
        return JSON.stringify(part);
      } catch {
        return String(part);
      }
    });
    const line = redact(`${new Date().toISOString()} ${level} ${parts.join(" ")}`, extras.secrets);
    stream.write(line + "\n");
  };
  return {
    info: (...args) => write("INFO", args),
    warn: (...args) => write("WARN", args),
    error: (...args) => write("ERROR", args),
  };
}
