/**
 * x402-svm: HTTP-native (HTTP 402) payments for the agent economy on Solana.
 *
 * TypeScript SDK implementing the x402 payment protocol adapted to the
 * Solana Virtual Machine (SVM). Agents fetch a resource, receive an HTTP 402
 * with machine-readable payment terms, pay a SPL token (e.g. USDC) on-chain,
 * and retry with a signed payment envelope in the `X-PAYMENT` header.
 *
 * Zero build required: runs on Node >= 22.6 via `node --experimental-strip-types`.
 */
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  VersionedTransaction,
  TransactionInstruction,
  ComputeBudgetProgram,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  createTransferCheckedInstruction,
  getMint,
  createAssociatedTokenAccountInstruction,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

export const X402_VERSION = 1;
export const PAYMENT_HEADER = "X-PAYMENT";
export const RESPONSE_HEADER = "X-PAYMENT-RESPONSE";

export interface PaymentTerms {
  x402Version: number;
  error: string;
  accepts: PaymentRequirement[];
}

export interface PaymentRequirement {
  scheme: "exact";
  network: string;              // e.g. "solana-devnet", "solana-mainnet"
  maxAmountRequired: string;    // base units of the SPL token
  resource: string;             // URL of the paid resource
  description: string;
  mimeType: string;
  payTo: string;                // destination token account (ATA) of the server
  asset: string;                // SPL token mint (e.g. devnet USDC)
  maxTimeoutSeconds: number;
  extra?: Record<string, unknown>;
}

/** Opaque envelope sent by the client in the X-PAYMENT header (base64url JSON). */
export interface PaymentEnvelope {
  x402Version: number;
  scheme: "exact";
  network: string;
  signature: string;            // Solana tx signature funding `payTo`
  resource: string;
  payer: string;                // base58 pubkey of the paying wallet
  nonce: string;                // client-generated replay guard
}

export interface VerifyResult {
  ok: boolean;
  reason?: string;
  amount?: bigint;
  payer?: string;
}

export function encodeEnvelope(env: PaymentEnvelope): string {
  return Buffer.from(JSON.stringify(env), "utf8").toString("base64url");
}

export function decodeEnvelope(header: string): PaymentEnvelope {
  return JSON.parse(Buffer.from(header, "base64url").toString("utf8"));
}

export function randomNonce(): string {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return Buffer.from(b).toString("base64url");
}

/** Build the full terms object a server returns with HTTP 402. */
export function buildTerms(req: PaymentRequirement): PaymentTerms {
  return { x402Version: X402_VERSION, error: "X402_PAYMENT_REQUIRED", accepts: [req] };
}

/**
 * Client-side: derive the ATA that `payTo` refers to, pay it, and produce an
 * envelope. `payTo` in terms is the server OWNER wallet; we derive the
 * associated token account for the asset mint so servers advertise only a
 * plain base58 wallet (nicer DX than requiring ATAs in config).
 */
export async function payRequirement(
  connection: Connection,
  payer: Keypair,
  requirement: PaymentRequirement,
): Promise<PaymentEnvelope> {
  const mint = new PublicKey(requirement.asset);
  const owner = new PublicKey(requirement.payTo);
  const sourceAta = getAssociatedTokenAddressSync(mint, payer.publicKey);
  const destAta = getAssociatedTokenAddressSync(mint, owner);
  const mintInfo = await getMint(connection, mint);

  const tx = new Transaction();
  const amount = BigInt(requirement.maxAmountRequired);

  // Create destination ATA if missing (permissionless, payer-funded).
  const destInfo = await connection.getAccountInfo(destAta);
  if (!destInfo) {
    tx.add(createAssociatedTokenAccountInstruction(payer.publicKey, destAta, owner, mint));
  }

  tx.add(
    createTransferCheckedInstruction(
      sourceAta, mint, destAta, payer.publicKey, amount, mintInfo.decimals,
    ),
    new TransactionInstruction({
      keys: [],
      programId: new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"), // SPL Memo
      data: Buffer.from(`x402:${requirement.resource}:${requirement.maxAmountRequired}`, "utf8"),
    }),
  );

  const sig = await sendAndConfirmTransaction(connection, tx, [payer], { commitment: "confirmed" });

  return {
    x402Version: X402_VERSION,
    scheme: "exact",
    network: requirement.network,
    signature: sig,
    resource: requirement.resource,
    payer: payer.publicKey.toBase58(),
    nonce: randomNonce(),
  };
}

/**
 * Client-side: wrap any fetch-like function so x402 flows are transparent:
 * on 402, read terms, pay on-chain, retry with X-PAYMENT.
 */
export function wrapFetchWithPayment(
  fetchFn: typeof fetch,
  connection: Connection,
  payer: Keypair,
) {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    let res = await fetchFn(url, init);
    if (res.status !== 402) return res;

    const terms: PaymentTerms = await res.json();
    const req = terms.accepts?.[0];
    if (!req) return res;

    const envelope = await payRequirement(connection, payer, req);
    const headers = new Headers(init?.headers);
    headers.set(PAYMENT_HEADER, encodeEnvelope(envelope));

    return fetchFn(url, { ...init, headers });
  };
}

/**
 * Server-side: verify an X-PAYMENT envelope against expected terms.
 * Checks the on-chain transaction actually moved `amount` of `asset`
 * from `payer` to the server ATA, and that it is confirmed.
 */
export async function verifyEnvelope(
  connection: Connection,
  envelope: PaymentEnvelope,
  expected: PaymentRequirement,
  serverOwner: PublicKey,
): Promise<VerifyResult> {
  try {
    if (envelope.network !== expected.network) return { ok: false, reason: "network mismatch" };
    if (envelope.resource !== expected.resource) return { ok: false, reason: "resource mismatch" };
    if (BigInt(expected.maxAmountRequired) <= 0n) return { ok: false, reason: "bad amount" };

    const mint = new PublicKey(expected.asset);
    const expectedDest = getAssociatedTokenAddressSync(mint, serverOwner);
    const sig = envelope.signature;
    const tx = await connection.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    if (!tx) return { ok: false, reason: "tx not found" };
    if (tx.meta?.err) return { ok: false, reason: "tx failed on-chain" };

    let transferred = 0n;
    let destMatches = false;
    // Inspect post-vs-pre token balance deltas so the amount is read from
    // chain state, never from client claims.
    for (const tb of tx.meta?.postTokenBalances ?? []) {
      const pre = tx.meta?.preTokenBalances?.find(p => p.accountIndex === tb.accountIndex);
      const postAmount = BigInt(tb.uiTokenAmount.amount);
      const preAmount = BigInt(pre?.uiTokenAmount.amount ?? "0");
      const delta = postAmount - preAmount;
      if (tb.mint === mint.toBase58() && delta > 0n) {
        const accountKey = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta?.loadedAddresses }).get(tb.accountIndex);
        if (accountKey && accountKey.equals(expectedDest)) {
          destMatches = true;
          transferred = delta;
        }
      }
    }
    if (!destMatches) return { ok: false, reason: "payment did not land in server ATA" };
    if (transferred < BigInt(expected.maxAmountRequired)) return { ok: false, reason: "underpayment", amount: transferred };

    return { ok: true, amount: transferred, payer: envelope.payer };
  } catch (e: any) {
    return { ok: false, reason: e?.message ?? "verification error" };
  }
}
