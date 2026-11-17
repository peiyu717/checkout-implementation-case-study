# Checkout.com Implementation Engineer Case Study

## Part 1 — API investigation

[Investigation answers](Part-1-Investigation.txt) describe the issues, fixes and recorded results for the six supplied requests.

## Part 2 — Checkout demo

A checkout page for one iPhone case, built with HTML, CSS, JavaScript and Express. It uses the supplied color palette and Checkout.com Flow for embedded card entry and authentication. Orders are stored in memory, with no database.

The journey covers entering details, paying, viewing the result and retrying after a decline. HKD and EUR sandbox payments were confirmed as Captured.

## Part 3 — Customizations

- Customer name and email passed to the payment API, with a hosted cardholder-name field.
- English, Traditional Chinese (Hong Kong) and Dutch for the page and Flow.
- HKD 100.00 and EUR 12.00 pricing.
- 3DS enabled with a challenge requested and non-3DS fallback disabled. Both successful and failed authentication were tested.

## Run the demo

See [setup, customer journey and tests](flow-demo/README.md). Sandbox credentials must be configured locally.
