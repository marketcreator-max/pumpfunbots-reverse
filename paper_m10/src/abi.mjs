import { keccak256 } from "./keccak.mjs";

export function eventTopic(signature) {
  return "0x" + keccak256(signature).toString("hex");
}

export function padAddress(addr) {
  const hex = addr.toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{40}$/.test(hex)) throw new Error("address must be 20 bytes");
  return "0x" + hex.padStart(64, "0");
}

export function addressFromWord(word) {
  const hex = word.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  return "0x" + hex.slice(24);
}

export function uintFromWord(word) {
  const hex = word.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  return BigInt("0x" + hex);
}

export function intFromWord(word) {
  const value = uintFromWord(word);
  return value >= 1n << 255n ? value - (1n << 256n) : value;
}

export function words(data) {
  const hex = data.toLowerCase().replace(/^0x/, "");
  const out = [];
  for (let i = 0; i < hex.length; i += 64) out.push("0x" + hex.slice(i, i + 64).padEnd(64, "0"));
  return out;
}

// Uniswap V2 / V3 signatures the adapter knows how to read.
export const UNISWAP_V2 = Object.freeze({
  pairCreated: "PairCreated(address,address,address,uint256)",
  swap: "Swap(address,uint256,uint256,uint256,uint256,address)",
  sync: "Sync(uint112,uint112)",
});

export const UNISWAP_V3 = Object.freeze({
  poolCreated: "PoolCreated(address,address,uint24,int24,address)",
  swap: "Swap(address,address,int256,int256,uint160,uint128,int24)",
});

export function decodeUniswapV2PairCreated(log) {
  const token0 = addressFromWord(log.topics[1]);
  const token1 = addressFromWord(log.topics[2]);
  const data = words(log.data);
  return { token0, token1, pair: addressFromWord(data[0]) };
}

export function decodeUniswapV2Swap(log) {
  const data = words(log.data);
  return {
    sender: addressFromWord(log.topics[1]),
    to: addressFromWord(log.topics[2]),
    amount0In: uintFromWord(data[0]),
    amount1In: uintFromWord(data[1]),
    amount0Out: uintFromWord(data[2]),
    amount1Out: uintFromWord(data[3]),
  };
}

export function decodeUniswapV2Sync(log) {
  const data = words(log.data);
  return { reserve0: uintFromWord(data[0]), reserve1: uintFromWord(data[1]) };
}

export function decodeUniswapV3PoolCreated(log) {
  const data = words(log.data);
  return {
    token0: addressFromWord(log.topics[1]),
    token1: addressFromWord(log.topics[2]),
    fee: Number(uintFromWord(log.topics[3])),
    tickSpacing: Number(intFromWord(data[0])),
    pool: addressFromWord(data[1]),
  };
}

export function decodeUniswapV3Swap(log) {
  const data = words(log.data);
  return {
    sender: addressFromWord(log.topics[1]),
    recipient: addressFromWord(log.topics[2]),
    amount0: intFromWord(data[0]),
    amount1: intFromWord(data[1]),
    sqrtPriceX96: uintFromWord(data[2]),
    liquidity: uintFromWord(data[3]),
    tick: Number(intFromWord(data[4])),
  };
}

// sqrtPriceX96 is sqrt(token1Raw/token0Raw) * 2^96.
// Returns token1 raw per 1 token0 raw, as a rational bigint pair { num, den }.
export function v3RawPrice(sqrtPriceX96) {
  const q = BigInt(sqrtPriceX96);
  return { num: q * q, den: 1n << 192n };
}
