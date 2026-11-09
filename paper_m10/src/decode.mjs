import { NATIVE_SOL, WSOL_MINT } from "./constants.mjs";
import { decodeEventBody } from "./borsh.mjs";
import { catalogs } from "./idl.mjs";
import { identityFor } from "./chain.mjs";

const ZERO = "11111111111111111111111111111111";
const STABLE_DECIMALS = new Map([
  ["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", 6],
  ["Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", 6],
]);

export function quoteIsSolMint(mint) {
  if (mint == null || mint === "") return true;
  return mint === WSOL_MINT || mint === NATIVE_SOL || mint === ZERO;
}

function asBig(value) {
  if (value == null) return 0n;
  return typeof value === "bigint" ? value : BigInt(value);
}

export function decodeProgramData(raw, catalog = catalogs()) {
  if (!raw || raw.length < 8) return null;
  const disc = raw.subarray(0, 8).toString("hex");
  const list = catalog.byDisc.get(disc) ?? [];
  if (!list.length) return { unknown: true, disc };
  let hit = list[0];
  let decoded = decodeEventBody(raw, hit.fields, hit.types);
  for (const candidate of list.slice(1)) {
    const attempt = decodeEventBody(raw, candidate.fields, candidate.types);
    const better = attempt.truncated === false && decoded.truncated;
    if (better) {
      hit = candidate;
      decoded = attempt;
    }
  }
  return {
    unknown: false,
    name: hit.name,
    program: hit.program,
    disc,
    truncated: decoded.truncated,
    trailingBytes: decoded.trailingBytes,
    fields: decoded.value,
  };
}

export function decodeLogLine(line, catalog = catalogs()) {
  if (!line.startsWith("Program data: ")) return null;
  const raw = Buffer.from(line.slice("Program data: ".length).trim(), "base64");
  return decodeProgramData(raw, catalog);
}

function pricingSol(fields) {
  const vQuote = asBig(fields.virtual_quote_reserves);
  const vSol = asBig(fields.virtual_sol_reserves);
  return vQuote > 0n ? vQuote : vSol;
}

// Pump decoder accepts only an explicit SOL mainnet identity.
export function eventsFromLogs({ logs, slot, signature, recvTs, blockTime, solUsd, solUsdAt, runId }) {
  const identity = identityFor("SOL", runId);
  const out = [];
  if (!Array.isArray(logs)) return out;
  for (const line of logs) {
    const decoded = decodeLogLine(line);
    if (!decoded || decoded.unknown || decoded.truncated) {
      if (decoded?.unknown) out.push({ type: "unknown", disc: decoded.disc, ...identity });
      continue;
    }
    const base = {
      ...identity,
      slot: slot ?? null,
      blockNumber: null,
      signature: signature ?? null,
      recvTs,
      blockTime: blockTime ?? null,
      solUsd: solUsd ?? null,
      solUsdAt: solUsdAt ?? null,
      truncated: decoded.truncated,
      trailingBytes: decoded.trailingBytes,
    };
    const f = decoded.fields;
    if (decoded.name === "CreateEvent") {
      out.push({
        ...base,
        type: "create",
        mint: f.mint,
        name: f.name ?? "",
        symbol: f.symbol ?? "",
        creator: f.creator ?? null,
        user: f.user ?? null,
        bondingCurve: f.bonding_curve ?? null,
        virtualSol: pricingSol(f) || asBig(f.virtual_sol_reserves),
        virtualToken: asBig(f.virtual_token_reserves),
        realToken: asBig(f.real_token_reserves),
        totalSupply: asBig(f.token_total_supply),
        quoteMint: f.quote_mint ?? null,
      });
    } else if (decoded.name === "TradeEvent") {
      const quoteMint = f.quote_mint ?? null;
      const solish = quoteIsSolMint(quoteMint);
      const stableDecimals = STABLE_DECIMALS.get(quoteMint);
      const quoteRaw = asBig(f.quote_amount) || asBig(f.sol_amount);
      const pricing = pricingSol(f);
      const vTok = asBig(f.virtual_token_reserves);
      let usd = null;
      let priceUsd = null;
      if (stableDecimals != null && vTok > 0n) {
        const quoteHuman = Number(pricing) / 10 ** stableDecimals;
        const tokenHuman = Number(vTok) / 1e6;
        priceUsd = tokenHuman > 0 ? quoteHuman / tokenHuman : null;
        usd = Number(quoteRaw) / 10 ** stableDecimals;
      }
      out.push({
        ...base,
        type: "trade",
        venue: "pump",
        mint: f.mint,
        pool: null,
        signer: f.user ?? null,
        funder: null,
        side: f.is_buy ? "buy" : "sell",
        solLamports: solish ? quoteRaw : 0n,
        quoteRaw,
        quoteIsSol: solish,
        usd,
        priceUsd,
        tokenRaw: asBig(f.token_amount),
        virtualSol: pricingSol(f),
        virtualToken: asBig(f.virtual_token_reserves),
        realSol: asBig(f.real_sol_reserves) || asBig(f.real_quote_reserves),
        realToken: asBig(f.real_token_reserves),
        feeBpsObserved: f.fee_basis_points == null ? null : Number(f.fee_basis_points),
        ixName: f.ix_name ?? null,
      });
    } else if (decoded.name === "CompletePumpAmmMigrationEvent") {
      out.push({
        ...base,
        type: "migrate",
        mint: f.mint,
        pool: f.pool,
        solLamports: asBig(f.sol_amount),
        tokenRaw: asBig(f.mint_amount),
      });
    } else if (decoded.name === "CreatePoolEvent" && decoded.program === "pumpswap") {
      out.push({
        ...base,
        type: "pool",
        mint: f.base_mint,
        pool: f.pool,
        quoteMint: f.quote_mint ?? null,
        creator: f.coin_creator ?? f.creator ?? null,
        virtualSol: asBig(f.pool_quote_amount),
        virtualToken: asBig(f.pool_base_amount),
        tokenDecimals: f.base_mint_decimals ?? 6,
        quoteDecimals: f.quote_mint_decimals ?? 9,
      });
    } else if (decoded.name === "BuyEvent" || decoded.name === "SellEvent") {
      const buy = decoded.name === "BuyEvent";
      const poolQuote = asBig(f.pool_quote_token_reserves);
      const virtualQuote = asBig(f.virtual_quote_reserves);
      const quoteReserve = poolQuote + virtualQuote;
      out.push({
        ...base,
        type: "trade",
        venue: "pumpswap",
        mint: null,
        pool: f.pool,
        signer: f.user ?? null,
        funder: null,
        side: buy ? "buy" : "sell",
        solLamports: buy ? (asBig(f.user_quote_amount_in) || asBig(f.quote_amount_in)) : (asBig(f.quote_amount_out) || asBig(f.user_quote_amount_out)),
        quoteRaw: buy ? asBig(f.quote_amount_in) : asBig(f.quote_amount_out),
        quoteIsSol: true,
        tokenRaw: buy ? asBig(f.base_amount_out) : asBig(f.base_amount_in),
        virtualSol: quoteReserve > 0n ? quoteReserve : poolQuote,
        virtualToken: asBig(f.pool_base_token_reserves),
        realSol: poolQuote,
        realToken: asBig(f.pool_base_token_reserves),
        feeBpsObserved: null,
        ixName: f.ix_name ?? null,
      });
    }
  }
  return out;
}

// Gross quote out of a PumpSwap sell before the fee is taken.
// Live sells match (poolQuote + virtualQuote) * baseIn / (poolBase + baseIn).
export function pumpswapQuoteOut({ poolQuote, virtualQuote, poolBase, baseIn }) {
  const quote = BigInt(poolQuote) + BigInt(virtualQuote);
  const base = BigInt(poolBase);
  const amount = BigInt(baseIn);
  if (base + amount === 0n) return 0n;
  return quote * amount / (base + amount);
}
