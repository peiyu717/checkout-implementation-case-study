// Synthetic UI tests exercise OUR journey with a stubbed SDK/provider. Never count these as real payments.
import { chromium } from "playwright";
import { createServer } from "node:http";
import { once } from "node:events";
import { writeFile, mkdir } from "node:fs/promises";
import assert from "node:assert/strict";
import { createApp } from "../server.js";
let app,
  quote,
  mode = "unknown",
  submitCalls = 0;
const server = createServer((req, res) => app(req, res));
server.listen(0, "127.0.0.1");
await once(server, "listening");
const base = `http://127.0.0.1:${server.address().port}`;
const response = (status, data) => ({
  status,
  ok: status < 300,
  json: async () => data,
});
app = createApp(
  {
    APP_URL: base,
    CKO_PUBLIC_KEY: "synthetic_public",
    CKO_SECRET_KEY: "synthetic_secret",
    CKO_PROCESSING_CHANNEL_ID: "pc_synthetic",
  },
  async (url, opts) => {
    if (url.endsWith("/submit")) {
      submitCalls++;
      if (mode === "unknown") throw Error("simulated timeout");
      return response(201, {
        id: "pay_synthetic",
        type: "card",
        status: mode === "failed" ? "Declined" : "Approved",
      });
    }
    if (url.includes("/payments/"))
      return response(200, {
        id: "pay_synthetic",
        reference: quote.reference,
        amount: quote.amount,
        currency: quote.currency,
        metadata: quote.metadata,
        status: mode === "failed" ? "Declined" : "Captured",
      });
    quote = JSON.parse(opts.body);
    return response(201, {
      id: "ps_synthetic",
      payment_session_secret: "synthetic",
    });
  },
);
const browser = await chromium.launch({
  headless: true,
  ...(process.env.BROWSER_EXECUTABLE
    ? { executablePath: process.env.BROWSER_EXECUTABLE }
    : {}),
});
await mkdir(new URL("../test-results/", import.meta.url), { recursive: true });
const results = {
  observedAt: new Date().toISOString(),
  environment: "local synthetic SDK/provider",
  checks: [],
};
const stub = `window.CheckoutWebComponents=async options=>({create:()=>({mount:selector=>{const button=document.createElement('button');button.textContent='Stub Pay';button.onclick=async()=>{options.onSubmit?.();const result=await options.handleSubmit(null,{session_data:'synthetic-opaque'});if(result)await options.onPaymentCompleted(null,result);};document.querySelector(selector).append(button);options.onReady?.();},unmount:()=>{document.querySelector('#flow-container').replaceChildren();}})});`;
async function page() {
  const p = await browser.newPage();
  await p.route("https://checkout-web-components.checkout.com/index.js", (r) =>
    r.fulfill({ contentType: "text/javascript", body: stub }),
  );
  await p.goto(base);
  await p.locator("#country option[value=HK]").waitFor({ state: "attached" });
  await p.selectOption("#country", "HK");
  await p.fill("#name", "Demo Customer");
  await p.fill("#email", "demo@example.com");
  await p.click("#continue");
  await p.getByText("Stub Pay", { exact: true }).waitFor();
  return p;
}
function pass(name) {
  results.checks.push({ name, status: "PASS" });
  console.log("PASS", name);
}
try {
  const p = await page();
  await p.getByText("Stub Pay", { exact: true }).click();
  await p.waitForFunction(
    () => document.querySelector("#status").dataset.state === "confirming",
  );
  assert.equal(await p.locator("#continue").isDisabled(), true);
  assert.equal(await p.locator("#currency").isDisabled(), true);
  assert.equal(await p.locator("#check").isVisible(), true);
  assert.equal(submitCalls, 1);
  await p.click("#check");
  assert.equal(submitCalls, 1);
  pass("timeout result offers status lookup, not another payment");
  await p.goto(base + "/?status=succeeded");
  await p.waitForFunction(
    () => document.querySelector("#status").dataset.state === "confirming",
  );
  assert.equal(await p.locator("#new-order").isVisible(), false);
  pass("forged URL success flag cannot turn an unknown payment into success");
  await p.close();
  mode = "failed";
  const q = await page();
  const reference = await q.locator("#reference").innerText();
  await q.getByText("Stub Pay", { exact: true }).click();
  await q.waitForFunction(
    () => document.querySelector("#status").dataset.state === "failed",
  );
  assert.equal(await q.locator("#back").isVisible(), true);
  pass("explicit decline provides a return/retry action");
  await q.click("#back");
  mode = "paid";
  await q.click("#continue");
  await q.getByText("Stub Pay", { exact: true }).click();
  await q.waitForFunction(
    () => document.querySelector("#status").dataset.state === "paid",
  );
  assert.equal(await q.locator("#reference").innerText(), reference);
  assert.equal(await q.locator("#new-order").isVisible(), true);
  pass("explicit retry reaches paid result under the same order");
  await q.close();
} catch (e) {
  results.failure = e.message;
  process.exitCode = 1;
  console.error("JOURNEY TEST FAILED", e.message);
} finally {
  await writeFile(
    new URL("../test-results/journey-results.json", import.meta.url),
    JSON.stringify(results, null, 2),
  );
  await browser.close();
  server.close();
}
