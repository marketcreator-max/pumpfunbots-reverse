import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeProgramData } from "../src/decode.mjs";
import { pumpswapQuoteOut } from "../src/decode.mjs";
import { encodeEvent } from "../src/borsh.mjs";
import { catalogs } from "../src/idl.mjs";
import { base58Encode } from "../src/borsh.mjs";

const root = new URL("../fixtures/", import.meta.url);

test("live TradeEvent matches the current pump IDL and keeps the extra 8 bytes", () => {
  const raw = Buffer.from(readFileSync(new URL("trade-event.b64", root), "utf8").trim(), "base64");
  const event = decodeProgramData(raw);
  assert.equal(event.name, "TradeEvent");
  assert.equal(event.truncated, false);
  assert.equal(event.trailingBytes, 8);
  assert.equal(event.fields.is_buy, true);
  assert.equal(event.fields.sol_amount, 13542232n);
  assert.equal(event.fields.token_amount, 1150442512604n);
  assert.equal(event.fields.ix_name, "buy");
  assert.equal(event.fields.virtual_sol_reserves, 16089117754n);
  assert.equal(event.fields.mint, "FvoqTu97ziQ9WvF83BD9mv1dySMAgUCMt8xnfVqhpump");
});

test("live PumpSwap SellEvent prices with pool quote plus virtual quote", () => {
  const raw = Buffer.from(readFileSync(new URL("sell-event.b64", root), "utf8").trim(), "base64");
  const event = decodeProgramData(raw);
  assert.equal(event.name, "SellEvent");
  assert.equal(event.program, "pumpswap");
  assert.equal(event.trailingBytes, 8);
  const gross = pumpswapQuoteOut({
    poolQuote: event.fields.pool_quote_token_reserves,
    virtualQuote: event.fields.virtual_quote_reserves,
    poolBase: event.fields.pool_base_token_reserves,
    baseIn: event.fields.base_amount_in,
  });
  assert.equal(gross, event.fields.quote_amount_out);
});

test("CreateEvent round-trips through the IDL, and a short buffer does not throw", () => {
  const { pump } = catalogs();
  const spec = pump.byName.get("CreateEvent");
  const pubkey = base58Encode(Buffer.alloc(32, 7));
  const value = {
    name: "Hello",
    symbol: "H",
    uri: "https://example.invalid/u",
    mint: pubkey,
    bonding_curve: pubkey,
    user: pubkey,
    creator: pubkey,
    timestamp: 10n,
    virtual_token_reserves: 5n,
    virtual_sol_reserves: 6n,
    real_token_reserves: 7n,
    token_total_supply: 8n,
    token_program: pubkey,
    is_mayhem_mode: false,
    is_cashback_enabled: false,
    quote_mint: pubkey,
    virtual_quote_reserves: 9n,
    creator_fee_bps: 1n,
    is_holder_reward: true,
    depth: 2,
  };
  const encoded = encodeEvent(spec.disc, spec.fields, value, spec.types);
  const decoded = decodeProgramData(encoded);
  assert.equal(decoded.fields.name, "Hello");
  assert.equal(decoded.fields.mint, pubkey);
  assert.equal(decoded.fields.is_holder_reward, true);
  assert.equal(decoded.truncated, false);
  const cut = decodeProgramData(encoded.subarray(0, 40));
  assert.equal(cut.truncated, true);
  assert.equal(cut.fields.name, "Hello");
});
