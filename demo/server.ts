/**
 * x402-svm demo: a real paid API.
 *
 *   GET /api/price    → SOL/USD spot quote, 0.001 USDC (devnet) per call
 *   GET /api/premium  → paywalled "research note", 0.01 USDC per read
 *   GET /api/stats    → live payment ledger (free)
 *   GET /             → dashboard
 *
 * Run: node --experimental-strip-types server.ts
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Connection, Keypair, LAMPORTS_PER_SOL, PublicKey,
} from "@solana/web3.js";
import {
  buildTerms, decodeEnvelope, verifyEnvelope, RESPONSE_HEADER, PAYMENT_HEADER,
  type PaymentRequirement,
} from "../sdk/src/index.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTTP_PORT = Number(process.env.PORT ?? 8787);
const RPC = process.env.SOL_RPC ?? "https://api.devnet.solana.com";
const NETWORK = "solana-devnet";
const USDC_MINT = new PublicKey(process.env.USDC_MINT ?? "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const PRICE_MICRO_USDC = "1000";     // 0.001 USDC
const PREMIUM_MICRO_USDC = "10000";  // 0.01 USDC

const connection = new Connection(RPC, "confirmed");

// --- server wallet -----------------------------------------------------------
const keyDir = path.join(__dirname, ".keys");
fs.mkdirSync(keyDir, { recursive: true });
const keyFile = path.join(keyDir, "server.json");
let serverWallet: Keypair;
if (fs.existsSync(keyFile)) {
  serverWallet = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(keyFile, "utf8"))));
} else {
  serverWallet = Keypair.generate();
  fs.writeFileSync(keyFile, JSON.stringify(Array.from(serverWallet.secretKey)));
}
console.log("server wallet:", serverWallet.publicKey.toBase58());

// --- live price (free upstream), cached 10s ----------------------------------
let priceCache: { v: number; at: number } = { v: 0, at: 0 };
async function solPrice(): Promise<number> {
  if (Date.now() - priceCache.at > 10_000) {
    const r = await fetch("https://api.coinbase.com/v2/prices/SOL-USD/spot");
    const j: any = await r.json();
    priceCache = { v: Number(j?.data?.amount ?? 0), at: Date.now() };
  }
  return priceCache.v;
}

// --- terms -------------------------------------------------------------------
function termsFor(resource: string, amount: string, description: string): PaymentRequirement {
  return {
    scheme: "exact",
    network: NETWORK,
    maxAmountRequired: amount,
    resource,
    description,
    mimeType: "application/json",
    payTo: serverWallet.publicKey.toBase58(),
    asset: USDC_MINT.toBase58(),
    maxTimeoutSeconds: 60,
  };
}

// --- payment ledger ----------------------------------------------------------
const ledgerFile = path.join(__dirname, ".payments.json");
let ledger: Array<{ at: string; resource: string; payer: string; signature: string; amount: string }> = [];
if (fs.existsSync(ledgerFile)) ledger = JSON.parse(fs.readFileSync(ledgerFile, "utf8"));
function record(rec: (typeof ledger)[number]) {
  ledger.push(rec);
  fs.writeFileSync(ledgerFile, JSON.stringify(ledger, null, 2));
}

const PREMIUM_NOTE = {
  title: "Why Solana is the right settlement layer for HTTP 402",
  note: "Agent workloads are bursty and stateless: thousands of tiny, independent calls. " +
        "Base-fee economics matter more than throughput ceilings. At ~0.000005 SOL per " +
        "signature, a fully-paid API session of 1,000 calls costs under a cent in fees, " +
        "and 400ms finality keeps the pay-then-retry loop inside one agent 'tick'. " +
        "That combination is what makes per-request monetization viable where L2 " +
        "sequencer latency or EVM gas floors would break agent UX.",
};

async function handlePaid(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: string,
  amount: string,
  description: string,
  payload: () => Promise<unknown> | unknown,
) {
  const terms = buildTerms(termsFor(url, amount, description));
  const envHeader = req.headers[PAYMENT_HEADER.toLowerCase()] as string | undefined;
  if (!envHeader) {
    res.writeHead(402, { "content-type": "application/json" });
    res.end(JSON.stringify(terms));
    return;
  }
  try {
    const envelope = decodeEnvelope(envHeader);
    const verdict = await verifyEnvelope(connection, envelope, terms.accepts[0], serverWallet.publicKey);
    if (!verdict.ok) {
      res.writeHead(402, { "content-type": "application/json", "x-payment-error": verdict.reason ?? "invalid" });
      res.end(JSON.stringify({ ...terms, verificationError: verdict.reason }));
      return;
    }
    record({
      at: new Date().toISOString(),
      resource: url,
      payer: envelope.payer,
      signature: envelope.signature,
      amount: amount,
    });
    const body = await payload();
    res.writeHead(200, {
      "content-type": "application/json",
      [RESPONSE_HEADER]: JSON.stringify({
        success: true, network: NETWORK, amount, payer: envelope.payer, txSignature: envelope.signature,
      }),
    });
    res.end(JSON.stringify(body));
  } catch (e: any) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "bad X-PAYMENT envelope", detail: String(e?.message ?? e) }));
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const route = `http://localhost:${HTTP_PORT}${url.pathname}`;

  if (url.pathname === "/api/price") {
    return handlePaid(req, res, route, PRICE_MICRO_USDC, "One SOL/USD spot quote", async () => ({
      pair: "SOL/USD", price: await solPrice(), source: "coinbase-spot", paidVia: "x402-svm",
    }));
  }
  if (url.pathname === "/api/premium") {
    return handlePaid(req, res, route, PREMIUM_MICRO_USDC, "Premium research note", () => PREMIUM_NOTE);
  }
  if (url.pathname === "/api/stats") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ totalPayments: ledger.length, ledger: ledger.slice(-25) }));
    return;
  }
  if (url.pathname === "/api/health") {
    const bal = await connection.getBalance(serverWallet.publicKey);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, network: NETWORK, wallet: serverWallet.publicKey.toBase58(), lamports: bal }));
    return;
  }

  // static dashboard
  if (url.pathname === "/deck") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(fs.readFileSync(path.join(__dirname, "public", "deck.html")));
    return;
  }
  if (url.pathname === "/" || url.pathname === "/index.html") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(fs.readFileSync(path.join(__dirname, "public", "index.html")));
    return;
  }
  res.writeHead(404); res.end("not found");
});

server.listen(HTTP_PORT, () => console.log(`x402-svm demo on http://localhost:${HTTP_PORT}`));
