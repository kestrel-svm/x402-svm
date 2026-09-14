/** Create a local demo token ("USDX", 6 decimals) and fund server+agent. node --experimental-strip-types makemint.ts */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Connection, Keypair, LAMPORTS_PER_SOL, Transaction, sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  createMint, mintTo, getOrCreateAssociatedTokenAccount, getMint,
} from "@solana/spl-token";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RPC = process.env.SOL_RPC ?? "http://127.0.0.1:8899";
const connection = new Connection(RPC, "confirmed");

function load(name: string): Keypair {
  const f = path.join(__dirname, ".keys", name);
  if (!fs.existsSync(f)) throw new Error(`missing ${f} — run fund.ts first`);
  return Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(f, "utf8"))));
}
const payer = load("payer.json");
const server = load("server.json");
const agent = load("agent.json");

console.log("creating mint (6 decimals)…");
const mint = await createMint(connection, payer, payer.publicKey, null, 6);
console.log("mint:", mint.toBase58());
fs.writeFileSync(path.join(__dirname, ".keys", "mint.json"), JSON.stringify(mint.toBase58()));

for (const [kp, label, usdc] of [[server, "server", 500_000_000n], [agent, "agent", 500_000_000n]] as const) {
  const ata = await getOrCreateAssociatedTokenAccount(connection, payer, mint, kp.publicKey);
  await mintTo(connection, payer, mint, ata.address, payer, usdc);
  console.log(label, "funded with", Number(usdc) / 1e6, "USDX at", ata.address.toBase58());
}
console.log("done");
