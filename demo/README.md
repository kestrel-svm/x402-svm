# x402-svm demo

Paid API + agent consumer.

```bash
npm install
node --experimental-strip-types fund.ts        # create + fund wallets (devnet airdrop)
node --experimental-strip-types server.ts      # paid API on :8787
node --experimental-strip-types agent.ts       # agent buys 3 resources
```

Environment:

- `SOL_RPC` — JSON-RPC endpoint (default: devnet). Use `http://127.0.0.1:8899` for `solana-test-validator`.
- `USDC_MINT` — SPL mint to settle in (default: devnet USDC `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`).
- On a local validator, run `node --experimental-strip-types makemint.ts` once to create a 6-decimal demo token and fund both wallets (500 USDX each).

Endpoints: `/api/price` (0.001), `/api/premium` (0.01), free: `/api/stats`, `/api/health`.
