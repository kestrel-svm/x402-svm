/** Fund devnet wallets: SOL for fees, USDC for payments. Run: node --experimental-strip-types fund.ts */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, getAccount, TOKEN_PROGRAM_ID } from "@solana/spl-token";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RPC = process.env.SOL_RPC ?? "https://api.devnet.solana.com";
const connection = new Connection(RPC, "confirmed");
const USDC_MINT = new PublicKey(process.env.USDC_MINT ?? "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");

function load(name: string): Keypair {
  const f = path.join(__dirname, ".keys", name);
  if (fs.existsSync(f)) return Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(f, "utf8"))));
  const kp = Keypair.generate();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(Array.from(kp.secretKey)));
  return kp;
}

async function airdrop(kp: Keypair, label: string, sol = 0.5) {
  for (let i = 0; i < 8; i++) {
    try {
      const sig = await connection.requestAirdrop(kp.publicKey, Math.round(sol * LAMPORTS_PER_SOL));
      const latest = await connection.getLatestBlockhash();
      await connection.confirmTransaction({ signature: sig, ...latest }, "confirmed");
      console.log(`airdropped ${sol} SOL to ${label}:`, sig);
      return true;
    } catch (e: any) {
      console.log(`airdrop ${label} attempt ${i + 1} failed: ${String(e?.message ?? e).slice(0, 120)}`);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
  return false;
}

const server = load("server.json");
const agent = load("agent.json");
console.log("server:", server.publicKey.toBase58());
console.log("agent :", agent.publicKey.toBase58());

for (const [kp, label] of [[server, "server"], [agent, "agent"]] as const) {
  const bal = await connection.getBalance(kp.publicKey);
  if (bal < 0.2 * LAMPORTS_PER_SOL) await airdrop(kp, label);
  else console.log(`${label} has ${bal / LAMPORTS_PER_SOL} SOL`);
}

const agentAta = getAssociatedTokenAddressSync(USDC_MINT, agent.publicKey);
try {
  const acc = await getAccount(connection, agentAta);
  console.log("agent USDC (base 1e6):", acc.amount.toString());
} catch {
  console.log("agent has no devnet USDC ATA. Ask the Circle devnet faucet (faucet.circle.com) for:", agent.publicKey.toBase58());
  console.log("…or set USDC_MINT to a custom test token and run maketoken.ts");
}
