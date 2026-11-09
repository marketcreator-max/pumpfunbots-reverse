// Constant-product paper fill. Fee is taken from the input on a buy and from
// the output on a sell. This module does not build or submit a transaction.

export function constantProductBuy({ virtualSol, virtualToken, solLamports, feeBps }) {
  const sol = BigInt(solLamports);
  const x = BigInt(virtualSol);
  const y = BigInt(virtualToken);
  const bps = BigInt(feeBps);
  if (x <= 0n || y <= 0n || sol <= 0n || bps < 0n || bps >= 10_000n) return null;
  const fee = sol * bps / 10_000n;
  const net = sol - fee;
  if (net <= 0n) return null;
  const tokensOut = y * net / (x + net);
  if (tokensOut <= 0n) return null;
  return { tokensOut, feeLamports: fee, netSol: net, solLamports: sol };
}

export function constantProductSell({ virtualSol, virtualToken, tokenIn, feeBps }) {
  const tokens = BigInt(tokenIn);
  const x = BigInt(virtualSol);
  const y = BigInt(virtualToken);
  const bps = BigInt(feeBps);
  if (x <= 0n || y <= 0n || tokens <= 0n || bps < 0n || bps >= 10_000n) return null;
  const gross = x * tokens / (y + tokens);
  const fee = gross * bps / 10_000n;
  const solOut = gross - fee;
  if (solOut < 0n) return null;
  return { solOut, feeLamports: fee, gross };
}

export function lamportsToUsd(lamports, solUsd) {
  if (solUsd == null) return null;
  return Number(lamports) / 1e9 * solUsd;
}

export function spotUsdPerToken(virtualSol, virtualToken, solUsd) {
  if (virtualToken == null || virtualSol == null || virtualToken === 0n || solUsd == null) return null;
  const sol = Number(virtualSol) / 1e9;
  const tokens = Number(virtualToken) / 1e6;
  if (!Number.isFinite(sol) || !Number.isFinite(tokens) || tokens <= 0) return null;
  return (sol / tokens) * solUsd;
}

export function marketCapUsd(virtualSol, virtualToken, supplyRaw, solUsd) {
  const spot = spotUsdPerToken(virtualSol, virtualToken, solUsd);
  if (spot == null || supplyRaw == null) return null;
  return spot * (Number(supplyRaw) / 1e6);
}

// HOOD V2 uses the same constant product. virtualSol is the quote reserve in
// raw quote units and virtualToken is the token reserve. The caller converts
// quote raw to USD with the quote token's own decimals and price.
export function quoteToUsd(quoteRaw, decimals, quoteUsd) {
  if (quoteRaw == null || quoteUsd == null) return null;
  return Number(quoteRaw) / 10 ** decimals * quoteUsd;
}

export function gasUsd({ gasPriceWei, gasUnits, ethUsd }) {
  if (gasPriceWei == null || ethUsd == null) return null;
  const wei = BigInt(gasPriceWei) * BigInt(gasUnits);
  return Number(wei) / 1e18 * ethUsd;
}
