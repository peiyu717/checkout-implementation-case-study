# Checkout.com Implementation Engineer Case Study

## Part 1 — API investigation

[Part-1-Investigation.txt](Part-1-Investigation.txt) covers the issues, corrections and recorded outcomes for the six supplied API requests.

## Part 2 — Checkout demo

- Fixed basket for one iPhone case, using the supplied color palette.
- Embedded card payments with Checkout.com Flow hosted fields.
- Server-side Payment Session creation, custom submission and payment-status retrieval.
- Successful sandbox card payments confirmed as Captured.
- Result handling for successful, declined and pending payments, with explicit retry after a decline and duplicate-submission protection.
- Responsive checkout layout and in-memory order storage, with no database required.

## Part 3 — Additional customizations

- Collect customer name and email and pass them to the payment API; display and prefill Flow's hosted cardholder-name field.
- Support English, Traditional Chinese (Hong Kong) and Dutch in the checkout page and Flow.
- Process HKD and EUR payments using server-controlled prices: HKD 100.00 and EUR 12.00.
- Enable 3DS, request a challenge and disable non-3DS fallback. Successful and failed authentication paths were tested, including a successful retry under the same order reference.

## Customer journey and flow control

1. **Review and enter details.** The basket and total stay visible throughout checkout. The customer selects currency, billing country and language, then enters name and email. Currency and billing country are independent; prices come from the server.
2. **Prepare the payment form.** Continue validates the details and creates a Payment Session before mounting Flow. Changing details before submission removes the old form and requires a new session, clearing previously entered card information. The backend rejects submissions from superseded attempts.
3. **Submit and authenticate.** Flow collects card details and handles 3DS. While payment is being submitted, the page disables settings and repeat actions. The backend also locks the attempt before contacting Checkout.com, so concurrent requests cannot submit it twice.
4. **Confirm the outcome.** A completion callback or redirect triggers a server-side payment lookup. The backend checks the order reference, attempt association, amount and currency before updating the page. A URL success flag alone cannot mark an order as paid.
5. **Resolve or retry.** Captured displays success. Authorized, Pending and uncertain outcomes keep payment locked and offer status checks. The page polls every 2.5 seconds for up to 12 checks, then offers manual checking. A timeout never automatically starts another payment. An explicit decline offers Back to checkout; the next attempt keeps the same order reference.
6. **Recover or start another purchase.** Reloading restores the order using its browser-session token and retrieves the current status. If the server has restarted and the order is unavailable, the page blocks payment and asks the customer to check the previous payment. After success, starting a separate new order requires confirmation.

Flow control is shared between the browser and backend: `public/app.js` manages form visibility, button availability, SDK callbacks and polling; `server.js` enforces order access, attempt locks and payment reconciliation; `domain.js` maps payment states and determines whether another attempt is allowed. Browser controls guide the customer, while backend checks enforce the payment rules.

## Run and test

See [flow-demo/README.md](flow-demo/README.md) for setup, payment flow and test commands. Sandbox credentials are configured locally and are not included in this repository.

Validation on 17 November 2026: 20 local tests, four synthetic browser checks and 24 live sandbox checks passed. HKD/EUR payments and the decline-to-retry flow reached Captured. Live functional tests used `ENABLE_RISK=false`.
