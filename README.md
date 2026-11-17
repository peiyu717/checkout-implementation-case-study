# Checkout.com Implementation Engineer Case Study

- [Part 1: API investigation](Part-1-Investigation.txt) explains the six supplied requests, corrections and recorded outcomes.
- [Part 2: Flow checkout](flow-demo/README.md) contains the runnable application and tests.

The demo offers an iPhone case in HKD and EUR, hosted card entry, 3DS, customer name/email and three interface languages. Apple Pay is configurable but disabled: domain enrollment and a wallet transaction have not been verified. The optional webhook receiver has local signed-event tests; real event delivery is not configured. Refunds are outside this implementation.

Source code and the API investigation are provided in this repository. Sandbox credentials must be configured locally.
