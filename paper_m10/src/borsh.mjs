const ALPH = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58Encode(buf) {
  const source = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (source.length === 0) return "";
  const digits = [0];
  for (let i = 0; i < source.length; i++) {
    let carry = source[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let str = "";
  for (let k = 0; source[k] === 0 && k < source.length - 1; k++) str += "1";
  for (let q = digits.length - 1; q >= 0; q--) str += ALPH[digits[q]];
  return str;
}

export function base58Decode(string) {
  if (string.length === 0) return Buffer.alloc(0);
  const bytes = [0];
  for (const char of string) {
    const value = ALPH.indexOf(char);
    if (value < 0) throw new Error("invalid base58");
    let carry = value;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (let i = 0; i < string.length && string[i] === "1"; i++) bytes.push(0);
  return Buffer.from(bytes.reverse());
}

function truncated(offset, value) {
  return { value, offset, truncated: true };
}

export function decodeValue(buf, type, types, offset) {
  if (typeof type === "string") {
    switch (type) {
      case "bool":
        if (offset >= buf.length) return truncated(offset);
        return { value: buf[offset] !== 0, offset: offset + 1, truncated: false };
      case "u8":
        if (offset >= buf.length) return truncated(offset);
        return { value: buf[offset], offset: offset + 1, truncated: false };
      case "u16":
        if (offset + 2 > buf.length) return truncated(offset);
        return { value: buf.readUInt16LE(offset), offset: offset + 2, truncated: false };
      case "u32":
        if (offset + 4 > buf.length) return truncated(offset);
        return { value: buf.readUInt32LE(offset), offset: offset + 4, truncated: false };
      case "u64":
        if (offset + 8 > buf.length) return truncated(offset);
        return { value: buf.readBigUInt64LE(offset), offset: offset + 8, truncated: false };
      case "i64":
        if (offset + 8 > buf.length) return truncated(offset);
        return { value: buf.readBigInt64LE(offset), offset: offset + 8, truncated: false };
      case "u128":
      case "i128": {
        if (offset + 16 > buf.length) return truncated(offset);
        const lo = buf.readBigUInt64LE(offset);
        const hi = buf.readBigUInt64LE(offset + 8);
        let value = lo + (hi << 64n);
        if (type === "i128" && value >= 1n << 127n) value -= 1n << 128n;
        return { value, offset: offset + 16, truncated: false };
      }
      case "pubkey":
        if (offset + 32 > buf.length) return truncated(offset);
        return { value: base58Encode(buf.subarray(offset, offset + 32)), offset: offset + 32, truncated: false };
      case "string": {
        if (offset + 4 > buf.length) return truncated(offset);
        const length = buf.readUInt32LE(offset);
        if (length > 10_000_000 || offset + 4 + length > buf.length) return truncated(offset);
        return {
          value: buf.subarray(offset + 4, offset + 4 + length).toString("utf8"),
          offset: offset + 4 + length,
          truncated: false,
        };
      }
      default:
        throw new Error(`unsupported borsh type ${type}`);
    }
  }
  if (type.defined) {
    const name = typeof type.defined === "string" ? type.defined : type.defined.name;
    const defined = types.get(name);
    if (!defined) throw new Error(`unknown defined type ${name}`);
    return decodeValue(buf, defined, types, offset);
  }
  if (type.vec) {
    if (offset + 4 > buf.length) return truncated(offset);
    const length = buf.readUInt32LE(offset);
    if (length > 100_000) return truncated(offset);
    const value = [];
    let cursor = offset + 4;
    for (let i = 0; i < length; i++) {
      const item = decodeValue(buf, type.vec, types, cursor);
      if (item.truncated) return { value, offset: item.offset, truncated: true };
      value.push(item.value);
      cursor = item.offset;
    }
    return { value, offset: cursor, truncated: false };
  }
  if (type.option) {
    if (offset >= buf.length) return truncated(offset);
    if (buf[offset] === 0) return { value: null, offset: offset + 1, truncated: false };
    return decodeValue(buf, type.option, types, offset + 1);
  }
  if (type.array) {
    const [inner, length] = type.array;
    const value = [];
    let cursor = offset;
    for (let i = 0; i < length; i++) {
      const item = decodeValue(buf, inner, types, cursor);
      if (item.truncated) return { value, offset: item.offset, truncated: true };
      value.push(item.value);
      cursor = item.offset;
    }
    return { value, offset: cursor, truncated: false };
  }
  if (type.kind === "struct") {
    const fields = type.fields ?? [];
    if (fields.length && typeof fields[0] === "string") return decodeValue(buf, fields[0], types, offset);
    const value = {};
    let cursor = offset;
    for (const field of fields) {
      const item = decodeValue(buf, field.type, types, cursor);
      if (item.truncated && item.value === undefined) return { value, offset: cursor, truncated: true };
      value[field.name] = item.value;
      cursor = item.offset;
      if (item.truncated) return { value, offset: cursor, truncated: true };
    }
    return { value, offset: cursor, truncated: false };
  }
  throw new Error(`unsupported borsh type ${JSON.stringify(type).slice(0, 80)}`);
}

export function decodeEventBody(buf, fields, types) {
  const value = {};
  let cursor = 8;
  let truncated = false;
  for (const field of fields) {
    const item = decodeValue(buf, field.type, types, cursor);
    if (item.truncated && item.value === undefined) {
      truncated = true;
      break;
    }
    value[field.name] = item.value;
    cursor = item.offset;
    if (item.truncated) {
      truncated = true;
      break;
    }
  }
  const trailingBytes = !truncated && cursor < buf.length ? buf.length - cursor : 0;
  return { value, offset: cursor, truncated, trailingBytes };
}

function pushU32(chunks, value) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value);
  chunks.push(buf);
}

export function encodeValue(type, value, types, chunks) {
  if (typeof type === "string") {
    switch (type) {
      case "bool":
        chunks.push(Buffer.from([value ? 1 : 0]));
        return;
      case "u8":
        chunks.push(Buffer.from([value & 0xff]));
        return;
      case "u16": {
        const buf = Buffer.alloc(2);
        buf.writeUInt16LE(value);
        chunks.push(buf);
        return;
      }
      case "u32":
        pushU32(chunks, value);
        return;
      case "u64":
      case "i64": {
        const buf = Buffer.alloc(8);
        if (type === "u64") buf.writeBigUInt64LE(BigInt(value));
        else buf.writeBigInt64LE(BigInt(value));
        chunks.push(buf);
        return;
      }
      case "u128":
      case "i128": {
        let num = BigInt(value);
        if (num < 0n) num += 1n << 128n;
        const buf = Buffer.alloc(16);
        buf.writeBigUInt64LE(num & ((1n << 64n) - 1n), 0);
        buf.writeBigUInt64LE(num >> 64n, 8);
        chunks.push(buf);
        return;
      }
      case "pubkey": {
        const raw = base58Decode(value);
        if (raw.length !== 32) throw new Error(`pubkey must be 32 bytes, got ${raw.length}`);
        chunks.push(raw);
        return;
      }
      case "string": {
        const raw = Buffer.from(value, "utf8");
        pushU32(chunks, raw.length);
        chunks.push(raw);
        return;
      }
      default:
        throw new Error(`unsupported encode type ${type}`);
    }
  }
  if (type.defined) {
    const name = typeof type.defined === "string" ? type.defined : type.defined.name;
    encodeValue(types.get(name), value, types, chunks);
    return;
  }
  if (type.vec) {
    pushU32(chunks, value.length);
    for (const item of value) encodeValue(type.vec, item, types, chunks);
    return;
  }
  if (type.kind === "struct") {
    for (const field of type.fields) encodeValue(field.type, value[field.name], types, chunks);
    return;
  }
  throw new Error(`unsupported encode type ${JSON.stringify(type).slice(0, 80)}`);
}

export function encodeEvent(discHex, fields, value, types) {
  const chunks = [Buffer.from(discHex, "hex")];
  for (const field of fields) encodeValue(field.type, value[field.name], types, chunks);
  return Buffer.concat(chunks);
}
