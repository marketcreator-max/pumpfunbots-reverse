// Keccak-256 (Ethereum pre-NIST padding). Used only to hash event signatures.

const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];

const RHO = [
  [0, 36, 3, 41, 18],
  [1, 44, 10, 45, 2],
  [62, 6, 43, 15, 61],
  [28, 55, 25, 21, 56],
  [27, 20, 39, 8, 14],
];

const MASK = (1n << 64n) - 1n;

function rotl(x, n) {
  const s = BigInt(n);
  return ((x << s) | (x >> (64n - s))) & MASK;
}

function keccakF(a) {
  for (let round = 0; round < 24; round++) {
    const c = new Array(5);
    for (let x = 0; x < 5; x++) c[x] = a[x][0] ^ a[x][1] ^ a[x][2] ^ a[x][3] ^ a[x][4];
    const d = new Array(5);
    for (let x = 0; x < 5; x++) d[x] = c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) a[x][y] = (a[x][y] ^ d[x]) & MASK;

    const b = Array.from({ length: 5 }, () => Array(5).fill(0n));
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) b[y][(2 * x + 3 * y) % 5] = rotl(a[x][y], RHO[x][y]);
    }
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 5; x++) {
        a[x][y] = (b[x][y] ^ ((~b[(x + 1) % 5][y]) & b[(x + 2) % 5][y])) & MASK;
      }
    }
    a[0][0] = (a[0][0] ^ RC[round]) & MASK;
  }
}

export function keccak256(input) {
  const data = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const rate = 136;
  const state = Array.from({ length: 5 }, () => Array(5).fill(0n));
  let offset = 0;
  while (offset + rate <= data.length) {
    absorb(state, data, offset, rate);
    keccakF(state);
    offset += rate;
  }
  const block = Buffer.alloc(rate);
  data.copy(block, 0, offset);
  block[data.length - offset] ^= 0x01;
  block[rate - 1] ^= 0x80;
  absorb(state, block, 0, rate);
  keccakF(state);
  const out = Buffer.alloc(32);
  let n = 0;
  for (let y = 0; y < 5 && n < 32; y++) {
    for (let x = 0; x < 5 && n < 32; x++) {
      const lane = state[x][y];
      for (let b = 0; b < 8 && n < 32; b++) out[n++] = Number((lane >> BigInt(8 * b)) & 0xffn);
    }
  }
  return out;
}

function absorb(state, block, offset, length) {
  for (let i = 0; i < length; i++) {
    const x = (i >> 3) % 5;
    const y = (i >> 3) / 5 | 0;
    state[x][y] = (state[x][y] ^ (BigInt(block[offset + i]) << BigInt((i & 7) * 8))) & MASK;
  }
}

export function keccak256Hex(input) {
  return "0x" + keccak256(input).toString("hex");
}
