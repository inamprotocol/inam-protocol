# Pay on proof

An AI agent may move money only against a verified INAM receipt. PayPal or Braintree (fiat) or USDC via x402 (crypto), same receipt, same reputation.

**Verified live on the Braintree sandbox (2026-11-10):** the honest run authorized 12.00 EUR and captured it against a finalized receipt; the swapped-delivery and overcharging runs authorized and then voided (MISMATCH); the unknown seller was refused before Braintree was called. A first run with the wrong currency configured authorized EUR against a USD job and was voided by the hold check (`HOLD_MISMATCH`), which is the guard doing its job.

An agent that pays up front can be paid for nothing: the seller takes the money and delivers less, something else, or nothing. The usual fix, giving the agent payment credentials and hoping its judgment holds, puts those credentials in the model's context. This demo is for developers wiring agents to real payment rails and for owners who want a budget that an agent can spend but cannot lose. The owner approves a hold once. The money moves only when the seller's signed receipt matches what the buyer actually received and what the rail actually holds. Anything else releases the hold. The receipt is a signed, content-addressed INAM record, so it is portable: anyone can verify it offline, and it becomes part of the seller's reputation, whichever rail carried the money.

```
 1. checkTrust(seller)            INAM: allow / escrow / deny
        | deny -> stop. No PayPal or x402 call is made.
        v
 2. Hold                          PayPal:    Orders v2, intent AUTHORIZE, owner approves once
        |                         Braintree: authorizePaymentMethod (PayPal wallet test nonce)
        |                         USDC:      signed EIP-3009 authorization, kept, not submitted
        v
 3. Seller delivers + signs       INAM receipt naming the delivery hash and the hold
        v
 4. Buyer acceptWork(receipt, { outputHash of what arrived, amount and currency held })
        match                   -> countersign, then capture   (PayPal capture / Braintree captureTransaction / x402 /settle)
        MISMATCH or NOT_COMPARED -> void                      (PayPal void / Braintree reverseTransaction / discard authorization)
                                   The payer is never charged.
```

## Quick start

From the repo root:

```
npm install
cd sdk-js && npm install && cd ..        # the demo imports sdk-js/src, which has its own dependencies
npx tsx examples/pay-on-proof/server.ts
```

Open http://localhost:8787. With no keys set, a PayPal stand-in answers with the documented response shapes and every order counts as approved, an in-process INAM registry is started in a temp directory, and the AI notes fall back to fixed text. Nothing touches the production registry or real money.

Pick the rail with the PayPal / USDC (x402) / Braintree toggle above the scenario buttons (the API takes `POST /api/run?scenario=...&rail=paypal|usdc|braintree`).

Keys go in `examples/pay-on-proof/.env` (gitignored; copy `.env.example`). The server loads it at start.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PAYPAL_CLIENT_ID` | unset | PayPal sandbox app client id. Set both PayPal vars to use the real sandbox instead of the stand-in. |
| `PAYPAL_CLIENT_SECRET` | unset | PayPal sandbox app secret. |
| `PAYPAL_BASE` | `https://api-m.sandbox.paypal.com` | PayPal API base. Leave it on sandbox. |
| `PUBLIC_URL` | `http://localhost:$PORT` | Base for PayPal's `return_url` / `cancel_url`. Must be reachable from the payer's browser. |
| `PORT` | `8787` | Demo server port. |
| `INAM_URL` | unset | Registry to use. Unset starts a throwaway in-process registry. |
| `GEMINI_API_KEY` / `ANTHROPIC_API_KEY` | unset | AI that writes the seller's work and explains each step. Gemini is used if both are set. `GEMINI_MODEL` / `CLAUDE_MODEL` override the model. |
| `X402_BUYER_PRIVATE_KEY` | unset | USDC rail: the buyer wallet's key, used to sign the EIP-3009 authorization. Testnet wallet only. |
| `X402_SELLER_ADDRESS` | unset | USDC rail: the seller's `payTo` address. |
| `X402_FACILITATOR_URL` | unset | USDC rail: the x402 facilitator that verifies and settles the authorization. |
| `BRAINTREE_PUBLIC_KEY` / `BRAINTREE_PRIVATE_KEY` | unset | Braintree sandbox API keys. Set both to use the real sandbox instead of the stand-in. |
| `BRAINTREE_CURRENCY` | `USD` | The sandbox merchant account's currency. A hold in another currency is voided (`HOLD_MISMATCH`). |
| `BRAINTREE_MERCHANT_ACCOUNT_ID` | unset | Merchant account to charge (picks the currency). Default: the account's default. |
| `BRAINTREE_NONCE` | `fake-paypal-one-time-nonce` | Sandbox test nonce for the payment method. The default simulates a PayPal wallet payment. |

## Braintree sandbox credentials

Braintree is a PayPal service, and its sandbox signup asks for no tax ID, so it is the PayPal-family sandbox open to developers in countries PayPal does not serve.

1. Sign up at https://apply.braintreegateway.com/signup/sandbox and activate the account from the email.
2. Settings > API > API Keys: generate a key and copy the Public Key and Private Key into `.env`.
3. Settings > Business > Merchant Accounts: note the currency and set `BRAINTREE_CURRENCY` to it.
4. Start the server, pick Braintree, run a scenario. There is no payer redirect: the test nonce stands in for the PayPal wallet, so hold, capture and void run server-side. Transactions appear under Transactions in the Braintree sandbox dashboard.

## PayPal sandbox credentials

1. Sign in at https://developer.paypal.com.
2. Apps & Credentials, switch to Sandbox, Create App (type Merchant). Copy the Client ID and Secret into `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET`.
3. Testing Tools > Sandbox Accounts: use the generated sandbox Personal account (or create one) to approve orders. Its email and password are under the account's details.
4. Start the server, run a scenario, click Approve in the timeline, log in as the sandbox Personal account and approve. PayPal sends you back to `/paypal/return`, and the demo authorizes, waits for delivery, then captures or voids.

## Scenarios

| Button | What the seller does | Result | What it proves |
|---|---|---|---|
| Honest seller | Delivers what it signs for | Captured | A matching receipt is the only path to capture. The countersigned receipt is finalized and counts toward the seller's reputation. |
| Swapped delivery | Delivers 40 characters, signs for the full text | `MISMATCH`, voided | The buyer compares the hash of what it received, not what the receipt says about itself. |
| Overcharging receipt | Receipt claims 120.00 on a 12.00 hold | `MISMATCH`, voided | The amount and currency are checked against what the rail holds, not what the seller claims. |
| Unknown seller | Has no INAM record | Refused at step 1 | A deny stops the job before any payment API is called. No hold is created. |

The same four run on either rail.

## Security model

- The gates are plain code in `payOnProof.ts`. The AI writes the seller's summary and a one-sentence note per step. It cannot choose the outcome: capture is reachable only after `acceptWork` returns a countersigned receipt.
- Credentials never enter model context. PayPal and wallet keys are read from the environment by the server. Prompts carry the job and the step event only.
- The buyer passes `acceptWork` the hash of the bytes it received and the amount and currency the rail reported as held. It never passes values taken from the receipt.
- `NOT_COMPARED` voids, the same as `MISMATCH`. If the buyer has no expected hash, or the seller's draft has none, nothing was compared, and absence is not difference: a check that did not run must not count as a pass. `acceptWork` refuses to sign in that case (sdk-js 0.24.0).
- If the hold differs from the job (amount or currency), the delivery fails, or `acceptWork` throws, the hold is voided.
- INAM never moves or holds money. It records the rail's own reference in `settlement.paymentRef` (for PayPal, `paypal:<authorization id>`).

## Tests

```
npx vitest run tests/payOnProof.test.ts
```

Runs the four scenarios against an in-process registry and the PayPal stand-in, and asserts which PayPal endpoints were and were not called.

## API calls used

PayPal (`paypal.ts`):

- `POST /v1/oauth2/token`: client-credentials token
- `POST /v2/checkout/orders`: create the order, `intent: "AUTHORIZE"`
- `POST /v2/checkout/orders/{id}/authorize`: place the hold after approval
- `POST /v2/payments/authorizations/{id}/capture`: capture against a verified receipt
- `POST /v2/payments/authorizations/{id}/void`: release the hold
- `GET /v2/checkout/orders/{id}`: read an order

Writes send a `PayPal-Request-Id`, so retries are idempotent.

USDC via x402: the buyer signs an EIP-3009 transfer authorization for the seller's address and keeps it. Capture sends it to the facilitator's settle endpoint. Void discards it; it is never submitted and lapses at its expiry.

INAM (sdk-js): `checkTrust`, `registerAgent`, `submitWork` (seller drafts and signs), `acceptWork` (buyer compares and countersigns).

## Limitations

- The PayPal client was built against PayPal's documented Orders v2 and Payments v2 APIs and has run only against the stand-in in `paypal.ts`, which returns the documented response shapes. It has not been run against the live PayPal sandbox. A sandbox run needs `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` from a PayPal developer sandbox app.
- PayPal authorizations expire. A job that outlives the authorization would need reauthorization, which the demo does not do.
- The Braintree rail has run against the live Braintree sandbox (see the top of this file). Its payment method is a sandbox test nonce that simulates a PayPal wallet, not a real payer approval.
- The stand-in treats every order as approved. Approval, cancel and payer-side errors are only exercised with real sandbox credentials.
- State lives in memory. Restarting the server loses runs and the in-process registry.
- New sellers get `escrow` from `checkTrust`, not `allow`. Both go through the hold, so the demo never pays up front.
- The USDC rail needs a funded testnet wallet and a facilitator that supports the chosen network.

## License

Apache-2.0, like the rest of the repository. See [LICENSE](../../LICENSE).
