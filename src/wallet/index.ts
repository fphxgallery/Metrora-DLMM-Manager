import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import {
  generateMnemonic,
  keypairFromMnemonic,
  keypairFromUnknown,
  saveKeypairFile,
  loadKeypairFile,
  toBase58Secret,
  toJsonArray,
  derivationPath,
} from "./keystore.js";

const DEFAULT_PATH = process.env.KEYPAIR_PATH ?? "./secrets/keypair.json";

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    if (key.includes("=")) {
      const [k, v] = key.split(/=(.*)/s);
      out[k] = v;
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
      out[key] = argv[++i];
    } else {
      out[key] = "true";
    }
  }
  return out;
}

function prompt(q: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(q, (ans) => (rl.close(), res(ans))));
}

const HELP = `
DLMM Manager wallet — manage the Solana keypair the app signs with.

Usage:
  npm run wallet -- <command> [options]

Commands:
  create               generate a NEW wallet (fresh seed phrase) and save it
  import               import an existing wallet (seed phrase / base58 / JSON)
  export               print the public key (and, with --yes, the secret)
  show                 print the public key for a keypair file

Options:
  --path <file>        keypair JSON file (default ${DEFAULT_PATH})
  --force              overwrite an existing keypair file
  --account <n>        BIP44 account index for seed phrases (default 0)
  --words <12|24>      seed length for 'create' (default 24)

  import sources (else you'll be prompted on stdin):
  --mnemonic "<phrase>"   import from a seed phrase
  --key <base58>          import from a base58 secret key
  --json <file>           import from a Solana CLI keypair JSON

  export:
  --yes                   REQUIRED to reveal the secret key
  --format base58|json    secret format (default base58)

Security:
  • Files are written chmod 600. Never commit them (.gitignore already excludes them).
  • Anyone with the seed phrase or secret key controls the funds. Store offline.
  • Passing secrets as flags exposes them in shell history / 'ps'. Prefer the stdin prompt.
`;

async function cmdCreate(a: Record<string, string>): Promise<void> {
  const path = a.path ?? DEFAULT_PATH;
  const words = (a.words === "12" ? 12 : 24) as 12 | 24;
  const account = Number(a.account ?? 0);

  const mnemonic = generateMnemonic(words);
  const kp = keypairFromMnemonic(mnemonic, account);
  saveKeypairFile(path, kp, a.force === "true");

  console.log(`\nNew wallet created and saved to ${path} (chmod 600).`);
  console.log(`\n  Public key: ${kp.publicKey.toBase58()}`);
  console.log(`  Path:       ${derivationPath(account)}`);
  console.log("\n  ────────────────────────────────────────────────────────────");
  console.log("  SEED PHRASE — write this down offline. It is shown ONCE.");
  console.log("  Anyone with it controls the funds. Do not screenshot or paste online.");
  console.log("  ────────────────────────────────────────────────────────────\n");
  console.log("  " + mnemonic + "\n");
  console.log("  This phrase imports into Phantom/Solflare/Backpack too (account 0).");
  console.log("  Fund it with the pool's tokens plus a little SOL for fees and rent.\n");
}

async function cmdImport(a: Record<string, string>): Promise<void> {
  const path = a.path ?? DEFAULT_PATH;
  const account = Number(a.account ?? 0);

  let kp;
  if (a.mnemonic) {
    kp = keypairFromMnemonic(a.mnemonic, account);
  } else if (a.key) {
    kp = keypairFromUnknown(a.key, account);
  } else if (a.json) {
    kp = keypairFromUnknown(readFileSync(a.json, "utf8"), account);
  } else {
    const input = await prompt("Paste seed phrase, base58 secret, or JSON array: ");
    if (!input.trim()) throw new Error("nothing entered");
    kp = keypairFromUnknown(input, account);
  }

  saveKeypairFile(path, kp, a.force === "true");
  console.log(`\nImported wallet saved to ${path} (chmod 600).`);
  console.log(`  Public key: ${kp.publicKey.toBase58()}\n`);
}

async function cmdExport(a: Record<string, string>): Promise<void> {
  const path = a.path ?? DEFAULT_PATH;
  const kp = loadKeypairFile(path);
  console.log(`\n  Public key: ${kp.publicKey.toBase58()}`);

  if (a.yes !== "true") {
    console.log("\n  Secret key hidden. Re-run with --yes to reveal it (handle with care).\n");
    return;
  }
  console.log("\n  WARNING: anyone with the line below controls the funds.\n");
  if ((a.format ?? "base58") === "json") {
    console.log("  " + toJsonArray(kp) + "\n");
  } else {
    console.log("  " + toBase58Secret(kp) + "\n");
  }
}

async function cmdShow(a: Record<string, string>): Promise<void> {
  const path = a.path ?? DEFAULT_PATH;
  const kp = loadKeypairFile(path);
  console.log(`\n  ${kp.publicKey.toBase58()}   (${path})\n`);
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const a = parseArgs(rest);
  if (!cmd || cmd === "help" || a.help) {
    console.log(HELP);
    return;
  }
  switch (cmd) {
    case "create":
      return cmdCreate(a);
    case "import":
      return cmdImport(a);
    case "export":
      return cmdExport(a);
    case "show":
      return cmdShow(a);
    default:
      console.error(`Unknown command "${cmd}". Run with no args for help.`);
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("wallet error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
