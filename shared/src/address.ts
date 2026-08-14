import { z } from "zod";

const basePattern = /^0x[0-9a-fA-F]{40}$/;
const rawTonPattern = /^(?:-1|0):[0-9a-fA-F]{64}$/;
const friendlyTonPattern = /^[A-Za-z0-9_-]{48}$/;
const base64Alphabet =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function decodeBase64Url(value: string): Uint8Array | null {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  if (normalized.length % 4 === 1) return null;
  const bytes: number[] = [];
  let bits = 0;
  let buffer = 0;

  for (const char of normalized.replace(/=+$/, "")) {
    const index = base64Alphabet.indexOf(char);
    if (index < 0) return null;
    buffer = (buffer << 6) | index;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return Uint8Array.from(bytes);
}

function crc16(bytes: Uint8Array): number {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

export function isBaseAddress(value: string): boolean {
  return basePattern.test(value);
}

export function isTonAddress(value: string): boolean {
  if (rawTonPattern.test(value)) return true;
  if (!friendlyTonPattern.test(value)) return false;
  const bytes = decodeBase64Url(value);
  if (!bytes || bytes.length !== 36) return false;
  if (![0x11, 0x51].includes(bytes[0] ?? -1)) return false;
  if (![0x00, 0xff].includes(bytes[1] ?? -1)) return false;
  return (
    (((bytes[34] ?? -1) << 8) | (bytes[35] ?? -1)) === crc16(bytes.slice(0, 34))
  );
}

export function sameBaseAddress(left: string, right: string): boolean {
  return (
    isBaseAddress(left) &&
    isBaseAddress(right) &&
    left.toLowerCase() === right.toLowerCase()
  );
}

export function tonAddressKey(value: string): string | null {
  if (rawTonPattern.test(value)) {
    const [workchain, hash] = value.split(":");
    return `${workchain}:${hash?.toLowerCase()}`;
  }
  if (!friendlyTonPattern.test(value)) return null;
  const bytes = decodeBase64Url(value);
  if (!bytes || bytes.length !== 36 || !isTonAddress(value)) return null;
  const workchain = bytes[1] === 0xff ? -1 : bytes[1];
  const hash = [...bytes.slice(2, 34)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `${workchain}:${hash}`;
}

export function sameTonAddress(left: string, right: string): boolean {
  const leftKey = tonAddressKey(left);
  return leftKey !== null && leftKey === tonAddressKey(right);
}

export const baseAddressSchema = z
  .string()
  .refine(isBaseAddress, "Invalid Base address");
export const tonAddressSchema = z
  .string()
  .refine(isTonAddress, "Invalid TON address");
