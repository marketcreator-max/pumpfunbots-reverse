// Chain identity is always passed in. Nothing in this package guesses a chain
// from an address, a program id, or a log shape.

export const STRATEGY_VERSION = "paper-m10-v1";

export const CHAIN_IDS = Object.freeze({
  SOL: "mainnet",
  HOOD: "4663",
});

export function identityFor(chain, runId) {
  if (chain !== "SOL" && chain !== "HOOD") {
    throw new Error(`chain must be SOL or HOOD, got ${chain ?? "undefined"}. Refusing to infer a chain.`);
  }
  if (!runId) throw new Error("run_id is required");
  return Object.freeze({
    chain,
    chain_id: CHAIN_IDS[chain],
    strategy_version: STRATEGY_VERSION,
    run_id: runId,
  });
}

export function assertIdentity(record, expected) {
  if (!record || record.chain !== expected.chain || String(record.chain_id) !== expected.chain_id) {
    throw new Error(
      `record chain ${record?.chain ?? "?"}/${record?.chain_id ?? "?"} does not match required ${expected.chain}/${expected.chain_id}`,
    );
  }
  if (record.strategy_version && record.strategy_version !== expected.strategy_version) {
    throw new Error(`strategy_version ${record.strategy_version} != ${expected.strategy_version}`);
  }
  if (record.run_id && record.run_id !== expected.run_id) {
    throw new Error(`run_id ${record.run_id} != ${expected.run_id}`);
  }
}

export function stamp(record, identity) {
  return {
    chain: identity.chain,
    chain_id: identity.chain_id,
    strategy_version: identity.strategy_version,
    run_id: identity.run_id,
    ...record,
  };
}
