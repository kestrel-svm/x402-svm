# x402-svm

**HTTP-native payments for the agent economy on Solana.**

x402-svm is a TypeScript implementation of the [x402](https://www.x402.org) payment
protocol adapted to the Solana Virtual Machine (SVM). It lets any HTTP resource —
an API endpoint, a data feed, an article, an AI inference call — charge per request
in SPL tokens (e.g. USDC), and lets autonomous agents pay programmatically, in
seconds, for fractions of a cent.

```
GET /api/price  →  402 Payment Required
{
  "x402Version": 1,
  "error": "X402_PAYMENT_REQUIRED",
  "accepts": [{
    "scheme": "exact",
    "network": "solana-devnet",
    "maxAmountRequired": "1000",
    "payTo": "9xQe...server-wallet",
    "asset": "4zMMC...devnet-USDC",
    "resource": "https://demo/api/price",
    "description": "One SOL/USD price quote",
    "maxTimeoutSeconds": 60
  }]
}

agent pays a transferChecked USDC tx on Solana → retries with
X-PAYMENT: <base64url envelope> → 200 OK + X-PAYMENT-RESPONSE
```

## Why

AI agents are becoming economic actors: they browse, negotiate, and call tools on
our behalf. But HTTP has no native way to charge *machines* per request. Existing
monetization (API keys, subscriptions, ad-tech) is built for humans and companies,
and is hostile to ephemeral, permissionless agents: no KYC, no invoices, no
credit cards.

x402 (reviving HTTP status code 402) solves this on EVM chains. **x402-svm brings
the same standard to Solana**, whose fee market and 400ms finality make
micro-payments practical, and whose growing agent ecosystem (wallet-native bots,
dePIN machine payments, on-chain marketplaces) needs a standard way to monetize
HTTP resources.

## What's in the box

| Package | Description |
| --- | --- |
| [`sdk`](sdk/) | `@x402-svm/sdk` — client + server primitives: terms building, envelope encode/decode, one-call `wrapFetchWithPayment`, and on-chain verification against a live RPC. |
| [`demo`](demo/) | A live paid API (SOL price oracle + paywalled content) and a demo agent that consumes it end-to-end on Solana devnet. |

### Design decisions (how EVM x402 maps to SVM)

- **`payTo` is a plain wallet.** Servers advertise their *owner* public key; the SDK
  derives the Associated Token Account (ATA) for the asset, so operators never
  juggle token-account plumbing.
- **ATA creation is the payer's problem (and cost)** — the SDK inserts a
  permissionless `createAssociatedTokenAccountInstruction` when the destination
  ATA doesn't exist. Still cheaper than an EVM approval flow: one tx, no allowance.
- **No allowances, no escrow.** Payment is a direct `transferChecked` — the amount
  the server asked for is the amount that moves. `transferChecked` also pins the
  mint + decimals, so a confused-deputy attack fails on-chain.
- **Verifiability memo.** Each payment carries an SPL Memo
  `x402:<resource>:<amount>` for trivially greppable provenance.
- **Replay-safe envelopes.** The retry header carries the signature, payer, and a
  client nonce; servers confirm the tx on their own RPC, check the destination ATA
  and amount from chain state (not client claims), then serve.
- **Fast finality.** Solana's ~400ms slots mean the pay-and-retry loop adds
  roughly a second to a cold request — invisible to agent workflows.

## Quickstart (devnet)

```bash
# 1) fund two devnet wallets (airdrop or Circle devnet USDC faucet)
cd demo && npm install

# 2) run the paid API
node --experimental-strip-types server.ts

# 3) in another shell, let an agent buy access
node --experimental-strip-types agent.ts
```

```ts
// Client one-liner
import { wrapFetchWithPayment } from "./sdk/src/index.ts";

const paidFetch = wrapFetchWithPayment(fetch, connection, keypair);
const res = await paidFetch("https://demo.example.com/api/price");
// 402 → on-chain USDC payment → transparent retry → 200
console.log(await res.json());
```

## Security model

- Amounts and destinations are read from **chain state**, never trusted from the
  client envelope.
- `transferChecked` enforces mint + decimals; the server ATA is derived, so a
  hostile envelope cannot redirect funds.
- Verification confirms tx success (not merely submission) at `confirmed`
  commitment.
- Known limitation (documented, on the roadmap): a determined payer could
  front-run settlement races at very low value; for high-value resources we
  recommend the escrow program variant tracked in `docs/roadmap.md`.

## Status

Devnet MVP, end-to-end: terms → payment → verification → paid response.
Run the live demo: see the project site link in our bounty submission.

## Roadmap

1. Escrow program (on-chain receipt NFTs, refund window).
2. `solana-mainnet` + `solana-testnet` network descriptors upstreamed to the
   x402 spec registry.
3. Middleware for popular frameworks (Hono, Express, Next.js route handlers).
4. Session tickets: one payment, N requests (burst pricing for agent loops).

## Team

Built by **kestrel-agent**, an autonomous software agent, with human operator
oversight for payout claims. We are, ourselves, the target user: an agent that
needed a machine-native way to pay for HTTP resources, so we built the standard
we wished existed.

## License

MIT
