import { Keypair } from "@solana/web3.js";
import { readFileSync, writeFileSync, existsSync, chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import bs58 from "bs58";
import * as bip39 from "bip39";
import { derivePath } from "ed25519-hd-key";

// Standard Solana / Phantom BIP44 derivation path. account is usually 0.
export const derivationPath = (account: number): string => `m/44'/501'/${account}'/0'`;

export function generateMnemonic(words: 12 | 24 = 24): string {
  // 128 bits => 12 words, 256 bits => 24 words.
  return bip39.generateMnemonic(words === 24 ? 256 : 128);
}

export function keypairFromMnemonic(phrase: string, account = 0): Keypair {
  const norm = phrase.trim().replace(/\s+/g, " ").toLowerCase();
  if (!bip39.validateMnemonic(norm)) {
    throw new Error("invalid seed phrase (check the words and their order)");
  }
  const seed = bip39.mnemonicToSeedSync(norm);
  const { key } = derivePath(derivationPath(account), seed.toString("hex"));
  return Keypair.fromSeed(key);
}

export function keypairFromBase58(secret: string): Keypair {
  return Keypair.fromSecretKey(bs58.decode(secret.trim()));
}

export function keypairFromJsonArray(text: string): Keypair {
  const arr = JSON.parse(text.trim()) as number[];
  if (!Array.isArray(arr)) throw new Error("expected a JSON array of bytes");
  return Keypair.fromSecretKey(Uint8Array.from(arr));
}

/** Best-effort detection so `import` accepts any common paste format. */
export function keypairFromUnknown(input: string, account = 0): Keypair {
  const s = input.trim();
  if (s.startsWith("[")) return keypairFromJsonArray(s);
  if (/\s/.test(s) && s.split(/\s+/).length >= 12) return keypairFromMnemonic(s, account);
  return keypairFromBase58(s);
}

export const toJsonArray = (kp: Keypair): string => JSON.stringify(Array.from(kp.secretKey));
export const toBase58Secret = (kp: Keypair): string => bs58.encode(kp.secretKey);

export function saveKeypairFile(path: string, kp: Keypair, force = false): void {
  if (existsSync(path) && !force) {
    throw new Error(`${path} already exists — pass --force to overwrite (this destroys the old key)`);
  }
  mkdirSync(dirname(path), { recursive: true });
  // Create with 0600 up front (no umask window), then chmod to fix an existing
  // file's perms on a --force overwrite.
  writeFileSync(path, toJsonArray(kp), { mode: 0o600 });
  chmodSync(path, 0o600); // owner read/write only
}

export function loadKeypairFile(path: string): Keypair {
  if (!existsSync(path)) throw new Error(`no keypair file at ${path}`);
  return keypairFromJsonArray(readFileSync(path, "utf8"));
}
