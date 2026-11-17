# CASE checkout

One iPhone case, priced at HKD 100.00 or EUR 12.00. The backend creates a Payment Session and the browser displays Checkout.com Flow.

## Setup

Requires Node.js 22.12+ and the assignment's Part 2 sandbox credentials.

```sh
npm ci
cp .env.example .env
```

Set `CKO_PUBLIC_KEY`, `CKO_SECRET_KEY`, `CKO_PROCESSING_CHANNEL_ID` and the account's sandbox `CKO_API_BASE` in `.env`, then run:

```sh
npm start
```

Open http://localhost:3000. For another port, update both `PORT` and `APP_URL` and open that exact address. Credentials are excluded from the repository.

## Customer journey

1. Review the basket, choose currency, billing country and language, then enter name and email.
2. Continue loads Flow. Changing details before payment clears the card form and prepares a new session on the next Continue.
3. Pay in the hosted form and complete 3DS if requested. Settings are disabled during submission, and the backend rejects duplicate submissions.
4. The result page retrieves the payment status from Checkout.com and checks that it matches the order. Captured shows success. Authorized or Pending continues checking, with a manual status button after automatic checks stop.
5. A decline offers Back to checkout. Retrying creates a new payment attempt under the same order reference. A timeout keeps the order awaiting confirmation rather than submitting another payment.
6. Reloading retrieves the existing order. After a successful payment, the customer can confirm starting a separate new order.

The basket stays visible throughout. Billing country is independent of currency, and prices are set by the server. Customer name/email go into the session's `customer` object; Flow also displays a hosted cardholder-name field.

## Flow control

`public/app.js` handles form changes, Flow callbacks and result polling. `server.js` creates and submits sessions, prevents repeat submissions and retrieves payments. `domain.js` defines prices, validates input and decides whether another attempt is allowed.

The backend submits Flow's opaque `session_data` and returns the provider response unchanged so Flow can handle authentication. It confirms the order reference, attempt, amount and currency before updating the result. Status checks run every 2.5 seconds, up to 12 times, and can then be requested manually.

Orders exist only in the running server process. Restarting loses them; an old browser order cannot automatically start another payment. A submission with an unknown outcome and no payment ID needs manual reconciliation.

## Tests

```sh
npm test
npx playwright install chromium
npm run test:journey
```

`npm test` checks backend rules and logging with a fake provider. `test:journey` checks the browser journey with a stub SDK/provider.

With the application running and `.env` configured:

```sh
npm run test:browser
```

This runs real sandbox card payments, including HKD/EUR, 3DS, decline/retry, languages and mobile layout. `BROWSER_EXECUTABLE` can select an existing Chrome installation. Reports are written to the ignored `test-results/` directory.

On 17 November 2026, 20 local tests, four simulated browser checks and 24 live sandbox checks passed. The live run used `ENABLE_RISK=false`, as set in `.env.example`, to test the payment journey independently of shared-account risk rules. Leaving the authentication page resulted in Pending, with another payment blocked.

## Logs

Payment events appear in the terminal and `logs/payments.jsonl`. Order reference, attempt ID and payment ID can be used to follow a payment. Customer details, keys and payment tokens are excluded.

## References

- [Flow integration](https://www.checkout.com/docs/get-started)
- [Payment Sessions](https://api-reference.checkout.com/tag/flow)
- [Payments API](https://api-reference.checkout.com/tag/payments)
- [Sandbox test cards](https://www.checkout.com/docs/developer-resources/testing/test-cards)
