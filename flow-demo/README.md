# CASE checkout

A fixed basket for one iPhone case: HKD 100.00 or EUR 12.00. Express creates a Checkout.com Payment Session, and the browser mounts Flow from the official CDN. Card fields and 3DS are handled by Flow; the application receives an opaque submission token, never raw card data.

## Run

Use Node.js 22.12+ and the assignment's **Part 2** sandbox credentials.

```sh
npm ci
cp .env.example .env
# Set the public key, secret key and processing channel in .env.
npm start
```

Open http://localhost:3000. When changing ports, update both `PORT` and `APP_URL`; use exactly that browser origin. Set `CKO_API_BASE` to the sandbox endpoint supplied for the account. Public-key scopes include `payment-sessions:pay` and `vault-tokenization`; the secret key needs session creation/submission and payment retrieval access. Credentials are not included.

## Payment flow

1. Choose currency, billing country and language; enter name/email.
2. Continue creates a session using the server's fixed price. Changing details clears the hosted form and invalidates the previous local attempt.
3. Flow sends its opaque token through `handleSubmit`. The backend locks the attempt before calling Checkout.com and returns the provider's submission response unchanged.
4. The result view retrieves payment details and checks the order reference, attempt, amount and currency. Captured means paid; authorized or pending stays locked until resolved.
5. An explicit decline permits a new attempt under the same order. A timeout is not treated as a decline and cannot automatically create another charge.

English, Traditional Chinese (Hong Kong) and Dutch are supported. The cardholder-name field is hosted by Flow; the separate customer name/email are sent in the session's `customer` object. Currency and billing country are independent. Prices are fixed catalog values, not an exchange-rate conversion.

## Tests

```sh
npm test
npx playwright install chromium
npm run test:journey
```

The first command tests application rules with a fake provider. The second suite tests browser behavior with a stub SDK/provider. Neither submits real payments.

With the app running and sandbox credentials configured:

```sh
npm run test:browser
```

This suite uses official sandbox test cards and performs sandbox payments. It covers hosted fields, HKD/EUR, 3DS, decline/retry, leaving authentication, localization and mobile width. Use `BROWSER_EXECUTABLE` to select an existing Chrome executable if needed. Reports are generated in ignored `test-results/`; screenshots are not required.

## Validation

On 17 November 2026, 20 local tests, four synthetic browser checks and 24 live sandbox checks passed. HKD/EUR payments and the decline-to-retry flow reached Captured. The live suite used `ENABLE_RISK=false`; leaving 3DS remained Pending with retry blocked. Apple Pay and actual webhook delivery were not exercised.

## Implementation

- `domain.js`: catalog, input validation, session payload and payment state rules.
- `server.js`: routes, submission lock, payment reconciliation and optional webhook receiver.
- `public/app.js`: Flow lifecycle, input controls, results and polling.
- `public/translations.js`: customer-facing translations.
- `payment-log.js`: allowlisted lifecycle logging with bounded file rotation.

Orders and attempts are in memory, as permitted by the brief. A restart invalidates browser order tokens. The server supports one process; the lock is not durable or distributed idempotency. An uncertain submission without a payment ID requires manual reconciliation. Production would need persistent order state and reliable webhook processing before fulfillment.

Logs are written to `logs/payments.jsonl` and the terminal, using reference, attempt ID and payment ID for correlation. Keys, names, emails, card fields, session tokens and raw provider responses are excluded. Log failures do not interrupt payment handling.

## Optional integrations and limits

**Sandbox risk screening:** `.env.example` sets `ENABLE_RISK=false` to isolate functional testing from shared-account risk rules. Set it to `true` to exercise screening; an unset value also enables it. A valid payment can then be declined by risk rules (for example, code 42101), including on retry. This switch is limited to the sandbox-only application.

**Apple Pay:** `ENABLE_APPLE_PAY=true` adds it to the session allowlist. It remains disabled by default because merchant onboarding, domain verification and a payment with an eligible wallet/device have not been completed. Do not treat an accepted session as proof of wallet payment support.

**Webhooks:** configure `CKO_WEBHOOK_SECRET` and an HTTPS receiver for `POST /webhooks/checkout`. The receiver validates the raw-body HMAC signature, checks payment correlation, deduplicates event IDs and prevents late events from reversing a captured state. It handles `payment_approved`, `payment_captured` and `payment_declined`. Real registration/delivery is unverified; the included tests use synthetic signed events. API retrieval alone does not mark a webhook as received.

3DS is enabled with non-3DS fallback disabled and a challenge requested. The issuer controls the authentication experience. Closing authentication can leave a payment pending; it does not establish cancellation. Hosted fields reduce exposure to card data but are not a claim of PCI certification. This demo has no fulfillment or refunds.

## References

- [Flow integration](https://www.checkout.com/docs/get-started)
- [Payment Sessions and custom submission](https://api-reference.checkout.com/tag/flow)
- [Payment retrieval](https://api-reference.checkout.com/tag/payments)
- [Sandbox test cards](https://www.checkout.com/docs/developer-resources/testing/test-cards)
- [Apple Pay domain verification](https://support.checkout.com/hc/en-us/articles/31004039588754-How-to-verify-a-domain-for-Apple-Pay-when-using-Flow)
