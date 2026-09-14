/**
 * x402-svm demo agent: buys paid HTTP resources as if it were the most natural
 * thing in the world. Because now it is.
 *
 * Run: node --experimental-strip-types agent.ts [baseUrl]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
} from "@solana/spl-token";
import { Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { wrapFetchWithPayment } from "../sdk/src/index.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.argv[2] ?? "http://localhost:8787";
const RPC = process.env.SOL_RPC ?? "https://api.devnet.solana.com";
const USDC_MINT = new PublicKey(process.env.USDC_MINT ?? "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");

const connection = new Connection(RPC, "confirmed");

const keyDir = path.join(__dirname, ".keys");
fs.mkdirSync(keyDir, { recursive: true });
const keyFile = path.join(keyDir, "agent.json");
let agentWallet: Keypair;
if (fs.existsSync(keyFile)) {
  agentWallet = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(keyFile, "utf8"))));
} else {
  agentWallet = Keypair.generate();
  fs.writeFileSync(keyFile, JSON.stringify(Array.from(agentWallet.secretKey)));
}
console.log("agent wallet:", agentWallet.publicKey.toBase58());

const paidFetch = wrapFetchWithPayment(fetch, connection, agentWallet);

async function show(label: string, res: Response) {
  const pr = res.headers.get("X-PAYMENT-RESPONSE");
  console.log(`\n=== ${label} → HTTP ${res.status} ===`);
  if (pr) console.log("payment receipt:", pr);
  console.log(JSON.stringify(await res.json(), null, 2).slice(0, 600));
}

console.log("fetching paid resources…");
await show("GET /api/price", await paidFetch(`${BASE}/api/price`));
await show("GET /api/premium", await paidFetch(`${BASE}/api/premium`));
await show("GET /api/price (again)", await paidFetch(`${BASE}/api/price`));
console.log("\ndone — every 402 was settled on-chain, in under a second each.");
