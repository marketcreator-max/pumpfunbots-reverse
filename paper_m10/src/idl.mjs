import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const IDL_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "idl");

export function loadIdl(fileName) {
  return JSON.parse(readFileSync(join(IDL_DIR, fileName), "utf8"));
}

export function eventCatalog(idl, program) {
  const types = new Map();
  for (const item of idl.types ?? []) types.set(item.name, item.type);
  const byDisc = new Map();
  const byName = new Map();
  for (const event of idl.events ?? []) {
    const disc = Buffer.from(event.discriminator).toString("hex");
    const struct = types.get(event.name);
    if (!struct || struct.kind !== "struct") {
      throw new Error(`IDL event ${event.name} has no struct fields`);
    }
    const record = { name: event.name, program, disc, fields: struct.fields, types };
    if (byDisc.has(disc)) throw new Error(`duplicate discriminator ${disc}`);
    byDisc.set(disc, record);
    byName.set(event.name, record);
  }
  return { byDisc, byName, types, address: idl.address };
}

let cached = null;

export function catalogs() {
  if (cached) return cached;
  const pump = eventCatalog(loadIdl("pump.json"), "pump");
  const amm = eventCatalog(loadIdl("pump_amm.json"), "pumpswap");
  const byDisc = new Map();
  const add = (record) => {
    const list = byDisc.get(record.disc) ?? [];
    list.push(record);
    byDisc.set(record.disc, list);
  };
  for (const record of pump.byDisc.values()) add(record);
  for (const record of amm.byDisc.values()) add(record);
  cached = { pump, amm, byDisc };
  return cached;
}
