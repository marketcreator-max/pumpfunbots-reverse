// Read-only program ids. This package never builds, signs, or sends transactions.

export const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
export const PUMP_AMM_PROGRAM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
export const WSOL_MINT = "So11111111111111111111111111111111111111112";
export const NATIVE_SOL = "11111111111111111111111111111111";

// pump.fun tokens: 1_000_000_000 human tokens, 6 decimals.
export const SUPPLY_RAW = 1_000_000_000_000_000n;
export const TOKEN_DECIMALS = 6;

// Pyth SOL/USD price account (hermes feed id, no 0x in the constant).
export const PYTH_SOL_USD_ID = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";

export const PUBLIC_ENDPOINTS = Object.freeze([
  {
    name: "public-mainnet",
    http: "https://api.mainnet-beta.solana.com",
    ws: "wss://api.mainnet-beta.solana.com",
  },
  {
    name: "publicnode",
    http: "https://solana-rpc.publicnode.com",
    ws: "wss://solana-rpc.publicnode.com",
  },
]);
