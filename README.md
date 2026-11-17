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

## Run and test

See [flow-demo/README.md](flow-demo/README.md) for setup, payment flow and test commands. Sandbox credentials are configured locally and are not included in this repository.

Validation on 17 November 2026: 20 local tests, four synthetic browser checks and 24 live sandbox checks passed. HKD/EUR payments and the decline-to-retry flow reached Captured. Live functional tests used `ENABLE_RISK=false`.
