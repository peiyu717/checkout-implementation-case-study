// Run explicitly: this file submits only documented SANDBOX test cards, never production payments.
// Live/browser evidence stays separate from injected-upstream unit tests.
import { chromium } from "playwright";
import assert from "node:assert/strict";
import { writeFile, mkdir } from "node:fs/promises";
const base = process.env.APP_URL || "http://localhost:3000";
let report = {
  observedAt: new Date().toISOString(),
  environment: "sandbox",
  origin: base,
  checks: [],
  payments: [],
  limitations: [
    "Apple Pay not exercised: enrollment/domain/device prerequisites pending.",
    "Webhook tests are synthetic; no real provider delivery registered.",
  ],
};
const reportDirectory = new URL("../test-results/", import.meta.url);
await mkdir(reportDirectory, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  ...(process.env.BROWSER_EXECUTABLE
    ? { executablePath: process.env.BROWSER_EXECUTABLE }
    : {}),
});
const check = (name, details = {}) => {
  report.checks.push({ name, status: "PASS", ...details });
  console.log("PASS", name);
};
function hostedName(frame) {
  try {
    return JSON.parse(
      Buffer.from(new URL(frame.url()).hash.slice(1), "base64").toString(),
    ).pageName;
  } catch {
    return "";
  }
}
async function hostedInput(page, name, value) {
  const until = Date.now() + 15000;
  let f;
  while (Date.now() < until) {
    f = page.frames().find((f) => hostedName(f) === name);
    if (f) break;
    await page.waitForTimeout(200);
  }
  assert.ok(f, `Hosted ${name} field exists`);
  await f.locator('input:not([aria-hidden="true"])').first().fill(value);
}
async function getOrder(page) {
  return page.evaluate(async () => {
    const r = await fetch("/api/order", {
      headers: { "X-Order-Token": sessionStorage.getItem("case.orderToken") },
    });
    return { status: r.status, ...(await r.json()) };
  });
}
async function setup(
  currency = "HKD",
  country = "HK",
  locale = "en-GB",
  mobile = false,
) {
  const context = await browser.newContext({
    viewport: mobile
      ? { width: 390, height: 844 }
      : { width: 1280, height: 900 },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  const merchantBodies = [];
  page.on("request", (r) => {
    if (r.url().startsWith(base + "/api/") && r.postData())
      merchantBodies.push(r.postData());
  });
  await page.goto(base);
  await page
    .locator("#country option[value=HK]")
    .waitFor({ state: "attached" });
  await page.selectOption("#locale", locale);
  await page.selectOption("#currency", currency);
  await page.selectOption("#country", country);
  await page.fill("#name", "Demo Customer");
  await page.fill("#email", "demo@example.com");
  await page.click("#continue");
  await page.locator("#flow-container iframe").first().waitFor();
  await page.waitForFunction(
    () =>
      document.querySelector("#status").textContent.length > 0 &&
      document.querySelector("#continue").hidden,
  );
  await page.waitForTimeout(1500);
  return { context, page, merchantBodies };
}
async function pay(page, card, action = "success") {
  const ref = (await getOrder(page)).reference;
  for (const [name, value] of [
    ["cardholder-name", "Demo Customer"],
    ["card-number", card],
    ["card-expiry-date", "0830"],
    ["card-cvv", "100"],
  ])
    await hostedInput(page, name, value);
  const submit = page.waitForResponse((r) => r.url() === base + "/api/submit");
  await page.locator("#flow-container button").last().click();
  const r = await submit;
  const body = await r.json();
  assert.equal(r.status(), 200, `Submit accepted: ${body.error || ""}`);
  assert.equal(await page.locator("#currency").isDisabled(), true);
  assert.equal(await page.locator("#locale").isDisabled(), true);
  check("settings locked while payment is submitted");
  let challenge = false;
  if (body.status === "Action Required") {
    const until = Date.now() + 55000;
    let acs;
    while (Date.now() < until) {
      for (const f of page.frames()) {
        if (
          await f
            .locator("input[name=password]")
            .isVisible()
            .catch(() => false)
        ) {
          acs = f;
          break;
        }
      }
      if (acs) break;
      await page.waitForTimeout(300);
    }
    assert.ok(acs, "Actual 3DS challenge has loaded");
    challenge = true;
    // Wait for the simulator handlers before submitting the visible form.
    await acs.waitForLoadState("load");

    check(`actual 3DS challenge displayed (${action})`);
    if (action === "cancel") {
      const buttons = await acs
        .locator("button,input[type=button],a")
        .evaluateAll((xs) =>
          xs.map((x) => ({
            tag: x.tagName,
            text: x.textContent || x.value || "",
          })),
        );
      report.checks.push({
        name: "3DS cancel controls observed",
        status: "OBSERVED",
        buttons,
      });
      const cancel = acs.getByText(/cancel/i).first();
      if (await cancel.isVisible().catch(() => false)) {
        await cancel.click();
      } else {
        report.checks.push({
          name: "Simulator has no visible cancel control; customer leaves authentication instead",
          status: "OBSERVED",
        });
        await page.goto(base + "/result");
      }
    } else {
      await acs
        .locator("input[name=password]")
        .fill(
          action === "wrong-password"
            ? "incorrect-test-password"
            : "Checkout1!",
        );
      await acs
        .locator("input[type=submit],button[type=submit]")
        .first()
        .click();
    }
  }
  // Poll server, including when the component completes without navigation. The server already saved payment ID.
  let observed;
  const until = Date.now() + 60000;
  while (Date.now() < until) {
    observed = await getOrder(page);
    if (
      action === "cancel" ||
      ["paid", "failed", "cancelled"].includes(observed.state)
    )
      break;
    await page.waitForTimeout(1500);
  }
  assert.equal(observed.reference, ref);
  await page.reload();
  await page.waitForTimeout(1500);
  const after = await getOrder(page);
  assert.equal(after.reference, ref);
  report.payments.push({
    paymentId: body.id,
    reference: ref,
    challenge,
    action,
    currency: observed.currency,
    amount: observed.amount,
    state: observed.state,
    paymentStatus: observed.paymentStatus,
    reloadState: after.state,
  });

  return observed;
}
async function verifyProvider(payment) {
  assert.match(
    process.env.CKO_API_BASE || "",
    /^https:\/\/(?:[a-z0-9-]+\.)?api\.sandbox\.checkout\.com$/,
  );
  const r = await fetch(
    `${process.env.CKO_API_BASE}/payments/${payment.paymentId}`,
    { headers: { Authorization: `Bearer ${process.env.CKO_SECRET_KEY}` } },
  );
  assert.equal(r.status, 200);
  const p = await r.json();
  assert.equal(p.reference, payment.reference);
  assert.equal(p.amount, payment.amount);
  assert.equal(p.currency, payment.currency);
  payment.providerStatus = p.status;
  assert.equal(p.status, "Captured");
  assert.equal(p["3ds"]?.authentication_response, "Y");
  assert.equal(p["3ds"]?.downgraded, false);
  payment.customerNameMatched = p.customer?.name === "Demo Customer";
  payment.customerEmailMatched = p.customer?.email === "demo@example.com";
  payment.authentication = {
    enrolled: p["3ds"]?.enrolled,
    authenticationResponse: p["3ds"]?.authentication_response,
    downgraded: p["3ds"]?.downgraded,
  };
  assert.equal(payment.customerNameMatched, true);
  assert.equal(payment.customerEmailMatched, true);
}
try {
  const s = await setup("HKD", "NL");

  const original = await getOrder(s.page);
  assert.equal(original.amount, 10000);
  assert.equal(original.billingCountry, "NL");
  check("HKD100 fixed basket with independent NL billing");
  // Local invalid input must not create a payment. No PAN is entered for this test.
  await s.page.locator("#flow-container button").last().click();
  await s.page.waitForTimeout(500);
  assert.equal(
    s.merchantBodies.some((x) => x.includes("sessionData")),
    false,
  );
  check("local empty-card validation does not submit a payment");
  for (const locale of ["zh-HK", "nl-NL"]) {
    await s.page.selectOption("#locale", locale);
    await s.page.waitForTimeout(200);
    assert.equal(await s.page.locator("#flow-container iframe").count(), 0);
    await s.page.click("#continue");
    await s.page.locator("#flow-container iframe").first().waitFor();
    await s.page.waitForTimeout(2000);
    const text = await s.page.locator("#flow-container").innerText();
    assert.ok(
      locale === "zh-HK"
        ? /卡|付款/.test(text)
        : /Kaart|kaart|Betalen/.test(text),
    );
    assert.equal((await getOrder(s.page)).reference, original.reference);
    check(`actual Flow and merchant locale ${locale}`, {
      flowLabels: text.replace(/\s+/g, " ").slice(0, 220),
    });
  }
  await s.page.selectOption("#currency", "EUR");
  await s.page.click("#continue");
  await s.page.locator("#flow-container iframe").first().waitFor();
  await s.page.waitForTimeout(1800);
  assert.equal((await getOrder(s.page)).amount, 1200);
  assert.equal((await getOrder(s.page)).reference, original.reference);
  check("changing currency creates EUR 12 attempt under original order");
  await s.context.close();
  const mobile = await setup("HKD", "HK", "zh-HK", true);
  assert.equal(
    await mobile.page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  check("mobile layout at 390px without horizontal overflow");
  await mobile.context.close();
  for (const [currency, country, locale] of [
    ["HKD", "HK", "en-GB"],
    ["EUR", "NL", "nl-NL"],
  ]) {
    const s = await setup(currency, country, locale);
    const result = await pay(s.page, "4242424242424242");
    assert.equal(result.state, "paid");
    check(`real ${currency} card payment captured after 3DS`);
    assert.equal(
      s.merchantBodies.some((x) => x.includes("4242424242424242")),
      false,
    );
    check("raw test PAN absent from merchant API requests");
    await verifyProvider(report.payments.at(-1));
    check(
      "independent provider GET confirms price, reference and customer fields",
    );
    await s.context.close();
  }
  const failure = await setup();
  const failed = await pay(failure.page, "4243754271700719");
  assert.equal(failed.state, "failed");
  assert.equal(failed.canRetry, true);
  check("authentication failure permits explicit retry");
  await failure.page.click("#back");
  await failure.page.fill("#name", "Demo Customer");
  await failure.page.fill("#email", "demo@example.com");
  await failure.page.click("#continue");
  await failure.page.locator("#flow-container iframe").first().waitFor();
  await failure.page.waitForTimeout(1500);
  const retried = await pay(failure.page, "4242424242424242");
  assert.equal(retried.state, "paid");
  assert.equal(retried.reference, failed.reference);
  check("failed authentication → successful retry retains order reference");
  await verifyProvider(report.payments.at(-1));
  await failure.context.close();
  const cancelled = await setup();
  const cancelResult = await pay(cancelled.page, "4242424242424242", "cancel");
  if (["failed", "cancelled"].includes(cancelResult.state)) {
    assert.equal(cancelResult.canRetry, true);
    check("challenge exit reaches retryable provider state", {
      state: cancelResult.state,
    });
  } else {
    assert.equal(cancelResult.canRetry, false);
    report.checks.push({
      name: "leaving challenge remains non-terminal; retry safely blocked",
      status: "OBSERVED",
      state: cancelResult.state,
    });
  }
  await cancelled.context.close();
} catch (e) {
  report.failure = { message: e.message.slice(0, 500) };
  console.error("BROWSER TEST FAILED", report.failure.message);
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(
    new URL("browser-results.json", reportDirectory),
    JSON.stringify(report, null, 2),
  );
  await browser.close();
}
