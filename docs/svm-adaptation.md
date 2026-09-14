# Adapting x402 to the Solana Virtual Machine

The EVM x402 spec defines: HTTP 402 terms, `scheme: exact`, an `X-PAYMENT`
header carrying an opaque envelope, and server-side verification. x402-svm keeps
the wire format byte-compatible in spirit and swaps the settlement layer.

## Field mapping

| x402 field (EVM)      | x402-svm (SVM)                                   |
| --------------------- | ------------------------------------------------ |
| `network`             | `solana-devnet` / `solana-mainnet` / custom      |
| `asset`               | SPL token mint (e.g. devnet USDC `4zMMC…ncDU`)   |
| `payTo`               | Server **owner wallet**; SDK derives the ATA     |
| `maxAmountRequired`   | Base units honored via `transferChecked` decimals|
| `extra.eip712Domain`  | not needed — no typed-data signatures            |
| envelope `signature`  | base58 tx signature of the settlement transfer   |

## Client payment construction

1. Derive `sourceAta = ATA(mint, payer)`, `destAta = ATA(mint, payTo)`.
2. If `destAta` does not exist, prepend
   `createAssociatedTokenAccountInstruction` (payer-funded, permissionless).
3. Add `transferChecked(source, mint, dest, payer, amount, decimals)`.
4. Add an SPL Memo instruction: `x402:<resource>:<amount>` for provenance.
5. Send, confirm at `confirmed`, wrap the signature in an envelope.

Notably absent vs EVM: **no approve/allowance step**. Solana transfers are
single-atomic instructions; there is no standing approval to overdraw.

## Server verification

1. Decode the base64url envelope; check `network`, `resource`, `scheme`.
2. Fetch the transaction by signature at `confirmed` from **our** RPC.
3. Confirm `meta.err` is null (settled, not merely submitted).
4. Recompute `destAta` from our owner wallet + the expected mint.
5. Walk `meta.postTokenBalances` vs `preTokenBalances` deltas for that exact
   account; require `delta >= maxAmountRequired` for the expected mint.
6. Amount and destination are always read from chain state — client claims are
   never trusted.

## Security notes

- `transferChecked` pins mint + decimals (no decimal-confusion attacks).
- Destination ATA is derived, so a malicious envelope cannot redirect funds.
- Replay: a signature is unique per settlement; resource + amount checks bind
  the payment to the request. A dedicated nonce registry (on-chain) is on the
  roadmap for high-value resources.
- Settlement races: we require `confirmed` commitment (~400 ms). For
  high-value endpoints, prefer the roadmap escrow program.

## Upstreaming

We propose `solana-devnet`, `solana-mainnet`, and `solana` (SVM family) network
descriptors for the x402 spec registry, with this repository as reference
implementation.
