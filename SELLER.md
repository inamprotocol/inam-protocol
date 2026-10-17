# Prove your payTo in 5 minutes

Goal: buyers running `inamprotocol check` or the INAM x402 gate see that your payTo wallet is controlled by a known INAM ID. No code reading, no key export, no gas.

## 1. Link your wallet (2 minutes)

```bash
npx inamprotocol link-wallet
```

It creates your INAM key at `~/.inam/seller-key.json` (keep it; it is your seller identity), registers your ID, and prints a one-time `http://127.0.0.1:...` link. Open it in the browser that has your wallet (MetaMask, Phantom EVM, Rabby), select the account that is your `payTo`, and confirm two signatures. The link expires in about 10 minutes; rerun the command if it does.

The terminal then prints your proof URL:

```
https://api.inamprotocol.org/v1/check?target=<your payTo>
```

## 2. Name your ID in the 402 (one line)

Print your ID (`Your INAM ID: did:key:...` from step 1), then add the middleware before your x402 payment middleware.

Express:

```ts
import { inamSellerMiddleware } from "inamprotocol";
app.use(inamSellerMiddleware("did:key:z6Mk..."));
app.use(paymentMiddleware(/* your x402 config */));
```

Hono:

```ts
import { inamSellerHono } from "inamprotocol";
app.use("*", inamSellerHono("did:key:z6Mk..."));
app.use(paymentMiddleware(/* your x402 config */));
```

Not using a middleware? Add `inamX402Extension(did)` to the `extensions` of your PaymentRequired object.

## 3. Verify

```bash
npx inamprotocol check https://your-api.example/paid-endpoint
```

You should see the `inam` extension's ID proving your payTo. Only the v2 `PAYMENT-REQUIRED` header is supported.

## Notes

- Linking only proves control of a wallet to one INAM ID; it moves no funds and signs no transaction.
- Your payTo must be the wallet account you sign with.
- Use `--registry URL` to point at a self-hosted registry.
