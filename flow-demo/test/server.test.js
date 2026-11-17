import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID, createHmac } from "node:crypto";
import { safeLogEntry } from "../payment-log.js";
import { createApp } from "../server.js";
import {
  settings,
  sessionPayload,
  newOrder,
  catalog,
  phase,
  verifySignature,
  snapshot,
} from "../domain.js";
const customer = {
  currency: "HKD",
  billingCountry: "NL",
  name: "Demo Customer",
  email: "demo@example.com",
  locale: "en-GB",
};
const config = {
  APP_URL: "http://localhost:3000",
  CKO_PUBLIC_KEY: "test_public",
  CKO_SECRET_KEY: "test_secret",
  CKO_PROCESSING_CHANNEL_ID: "pc_test",
  CKO_WEBHOOK_SECRET: "webhook_test",
};
function response(status, body) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}
async function fixture(
  t,
  upstream = async () =>
    response(201, {
      id: "ps_example",
      payment_session_secret: "private-session",
    }),
) {
  const logs = [];
  const app = createApp(config, upstream, {
      logger: (event, fields) => logs.push(safeLogEntry(event, fields)),
    }),
    server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  async function req(path, { method = "GET", body, token, headers = {} } = {}) {
    const r = await fetch(base + path, {
      method,
      headers: {
        Origin: config.APP_URL,
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(token ? { "X-Order-Token": token } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { status: r.status, data, headers: r.headers };
  }
  async function order(input = customer, key = randomUUID()) {
    return req("/api/orders", {
      method: "POST",
      body: input,
      headers: { "X-Create-Key": key },
    });
  }
  return { req, order, base, logs };
}
test("payload uses catalog, independent billing, customer, locale, required challenge", () => {
  for (const currency of ["HKD", "EUR"]) {
    const o = newOrder(settings({ ...customer, currency }));
    const p = sessionPayload(o, { id: "attempt" }, config);
    assert.equal(p.amount, catalog[currency]);
    assert.equal(p.items[0].quantity, 1);
    assert.equal(p.items[0].unit_price, p.amount);
    assert.equal(p.billing.address.country, "NL");
    assert.equal(p.customer.email, customer.email);
    assert.equal(p.locale, "en-GB");
    assert.equal(p.capture, true);
    assert.deepEqual(p.enabled_payment_methods, ["card"]);
    assert.deepEqual(p["3ds"], {
      enabled: true,
      attempt_n3d: false,
      challenge_indicator: "challenge_requested_mandate",
    });
    assert.equal(p.shipping, undefined);
    assert.equal(p.success_url, p.failure_url);
  }
});
test("raw card/amount fields, unsupported currency/country/locale and invalid customer rejected", () => {
  for (const input of [
    { ...customer, amount: 1 },
    { ...customer, number: "test" },
    { ...customer, cvv: "100" },
    { ...customer, currency: "GBP" },
    { ...customer, billingCountry: "XX" },
    { ...customer, locale: "xx" },
    { ...customer, email: "invalid" },
    { ...customer, name: "x" },
  ])
    assert.throws(() => settings(input));
});
test("every result maps safely, unknown cannot become success", () => {
  for (const [status, expected] of [
    ["Captured", "paid"],
    ["Authorized", "authorized"],
    ["Pending", "pending"],
    ["Declined", "failed"],
    ["Canceled", "cancelled"],
    ["Unexpected", "confirming"],
  ])
    assert.equal(
      phase({ stage: "submitted", paymentStatus: status }),
      expected,
    );
});
test("same order creation key is idempotent within the demo process", async (t) => {
  const f = await fixture(t);
  const key = randomUUID();
  const a = await f.order(customer, key),
    b = await f.order(customer, key);
  assert.equal(a.data.token, b.data.token);
  assert.equal(a.data.order.reference, b.data.order.reference);
});
test("origin, ownership and private file boundaries", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (
      await f.req("/api/orders", {
        method: "POST",
        body: customer,
        headers: {
          Origin: "https://evil.example",
          "X-Create-Key": randomUUID(),
        },
      })
    ).status,
    403,
  );
  assert.equal((await f.req("/api/order", { token: "other" })).status, 404);
  for (const path of ["/.env", "/server.js", "/domain.js", "/package.json"])
    assert.equal((await f.req(path)).status, 404);
  const c = await f.req("/api/config");
  assert.equal(JSON.stringify(c.data).includes(config.CKO_SECRET_KEY), false);
  assert.equal(c.headers.get("cache-control"), "no-store");
});
test("change currency/language creates a new matching session with the SAME reference; old attempt cannot submit", async (t) => {
  const payloads = [];
  const f = await fixture(t, async (url, opt) => {
    payloads.push(JSON.parse(opt.body));
    return response(201, {
      id: `ps_${payloads.length}`,
      payment_session_secret: "secret",
    });
  });
  const { token } = (await f.order()).data;
  const one = await f.req("/api/sessions", { method: "POST", body: {}, token });
  assert.equal(one.status, 201);
  await f.req("/api/settings", {
    method: "POST",
    token,
    body: { ...customer, currency: "EUR", locale: "nl-NL" },
  });
  const two = await f.req("/api/sessions", { method: "POST", body: {}, token });
  assert.equal(two.status, 201);
  assert.equal(payloads[1].amount, 1200);
  assert.equal(payloads[1].currency, "EUR");
  assert.equal(payloads[1].locale, "nl-NL");
  assert.equal(payloads[1].reference, payloads[0].reference);
  assert.equal(
    (
      await f.req("/api/submit", {
        method: "POST",
        token,
        body: { attemptId: one.data.attemptId, sessionData: "opaque" },
      })
    ).status,
    409,
  );
});
test("duplicate concurrent payment submits make only ONE upstream call; pass response unchanged", async (t) => {
  let calls = 0,
    release;
  const waiting = new Promise((r) => (release = r));
  const submitResponse = {
    id: "pay_example",
    status: "Action Required",
    type: "card",
    _links: { redirect: { href: "https://example.com/challenge" } },
  };
  const f = await fixture(t, async (url) => {
    if (url.endsWith("/submit")) {
      calls++;
      await waiting;
      return response(202, submitResponse);
    }
    return response(201, {
      id: "ps_example",
      payment_session_secret: "secret",
    });
  });
  const { token } = (await f.order()).data;
  const a = (await f.req("/api/sessions", { method: "POST", body: {}, token }))
    .data;
  const first = f.req("/api/submit", {
    method: "POST",
    token,
    body: { attemptId: a.attemptId, sessionData: "opaque" },
  });
  while (!calls) await new Promise((r) => setTimeout(r, 5));
  const second = await f.req("/api/submit", {
    method: "POST",
    token,
    body: { attemptId: a.attemptId, sessionData: "opaque" },
  });
  assert.equal(second.status, 409);
  release();
  assert.deepEqual((await first).data, submitResponse);
  assert.equal(calls, 1);
  assert.equal(
    (await f.req("/api/settings", { method: "POST", token, body: customer }))
      .status,
    409,
  );
});
test("timeout stays unknown and blocks retry/settings; no automatic upstream retry", async (t) => {
  let calls = 0;
  const f = await fixture(t, async (url) => {
    if (url.endsWith("/submit")) {
      calls++;
      throw Error("timeout");
    }
    return response(201, { id: "ps_example" });
  });
  const { token } = (await f.order()).data;
  const a = (await f.req("/api/sessions", { method: "POST", body: {}, token }))
    .data;
  assert.equal(
    (
      await f.req("/api/submit", {
        method: "POST",
        token,
        body: { attemptId: a.attemptId, sessionData: "opaque" },
      })
    ).status,
    502,
  );
  const state = (await f.req("/api/order", { token })).data;
  assert.equal(state.state, "confirming");
  assert.equal(state.canRetry, false);
  assert.equal(calls, 1);
  assert.equal(
    (await f.req("/api/sessions", { method: "POST", body: {}, token })).status,
    409,
  );
});
test("lookup verifies reference, amount, currency, attempt ownership and does not trust success URL", async (t) => {
  let payload, payment;
  const f = await fixture(t, async (url, opt) => {
    if (url.includes("/payments/")) return response(200, payment);
    if (url.endsWith("/submit"))
      return response(201, {
        id: "pay_example",
        status: "Approved",
        type: "card",
      });
    payload = JSON.parse(opt.body);
    return response(201, { id: "ps_example" });
  });
  const { token } = (await f.order()).data;
  const a = (await f.req("/api/sessions", { method: "POST", body: {}, token }))
    .data;
  await f.req("/api/submit", {
    method: "POST",
    token,
    body: { attemptId: a.attemptId, sessionData: "opaque" },
  });
  const good = {
    id: "pay_example",
    reference: payload.reference,
    amount: 10000,
    currency: "HKD",
    metadata: payload.metadata,
    status: "Captured",
  };
  for (const bad of [
    { ...good, reference: "wrong" },
    { ...good, amount: 1 },
    { ...good, currency: "EUR" },
    { ...good, id: "pay_other", metadata: { attempt_id: "other" } },
  ]) {
    payment = bad;
    assert.equal(
      (await f.req("/api/order?paymentId=" + bad.id, { token })).status,
      404,
    );
  }
  payment = { ...good, status: "Authorized" };
  assert.equal((await f.req("/api/order", { token })).data.state, "authorized");
  assert.equal(
    (await f.req("/api/sessions", { method: "POST", body: {}, token })).status,
    409,
  );
  payment = good;
  assert.equal((await f.req("/api/order", { token })).data.state, "paid");
  assert.equal((await f.req("/api/order", { token })).data.canRetry, false);
});
test("explicit decline permits a new attempt with same logical order reference", async (t) => {
  const sent = [];
  let quote;
  const f = await fixture(t, async (url, opt) => {
    if (url.endsWith("/submit"))
      return response(201, {
        id: "pay_declined",
        status: "Declined",
        type: "card",
      });
    if (url.includes("/payments/"))
      return response(200, {
        id: "pay_declined",
        reference: quote.reference,
        amount: 10000,
        currency: "HKD",
        metadata: quote.metadata,
        status: "Declined",
      });
    quote = JSON.parse(opt.body);
    sent.push(quote);
    return response(201, { id: "ps_example" });
  });
  const { token } = (await f.order()).data;
  const a = (await f.req("/api/sessions", { method: "POST", body: {}, token }))
    .data;
  await f.req("/api/submit", {
    method: "POST",
    token,
    body: { attemptId: a.attemptId, sessionData: "opaque" },
  });
  assert.equal((await f.req("/api/order", { token })).data.canRetry, true);
  assert.equal(
    (await f.req("/api/sessions", { method: "POST", body: {}, token })).status,
    201,
  );
  assert.equal(sent[0].reference, sent[1].reference);
  assert.notEqual(sent[0].metadata.attempt_id, sent[1].metadata.attempt_id);
});
test("restart rejects old order token instead of silently creating another payment", async (t) => {
  const f = await fixture(t),
    g = await fixture(t);
  const { token } = (await f.order()).data;
  assert.equal((await g.req("/api/order", { token })).status, 404);
});
test("signature rejection, verified event deduplication and out-of-order capture protection (SYNTHETIC)", async (t) => {
  let quote;
  const f = await fixture(t, async (url, opt) => {
    if (url.includes("/payments/"))
      return response(200, {
        id: "pay_example",
        reference: quote.reference,
        amount: 10000,
        currency: "HKD",
        metadata: quote.metadata,
        status: "Pending",
      });
    if (url.endsWith("/submit"))
      return response(201, {
        id: "pay_example",
        status: "Approved",
        type: "card",
      });
    quote = JSON.parse(opt.body);
    return response(201, { id: "ps_example" });
  });
  const { token } = (await f.order()).data;
  const a = (await f.req("/api/sessions", { method: "POST", body: {}, token }))
    .data;
  await f.req("/api/submit", {
    method: "POST",
    token,
    body: { attemptId: a.attemptId, sessionData: "opaque" },
  });
  const event = {
    id: "evt_1",
    type: "payment_captured",
    data: {
      id: "pay_example",
      reference: quote.reference,
      amount: 10000,
      currency: "HKD",
      metadata: quote.metadata,
    },
  };
  async function deliver(e, signature) {
    const raw = JSON.stringify(e);
    return f.req("/webhooks/checkout", {
      method: "POST",
      body: e,
      headers: {
        "cko-signature":
          signature ||
          createHmac("sha256", config.CKO_WEBHOOK_SECRET)
            .update(raw)
            .digest("hex"),
      },
    });
  }
  assert.equal((await deliver(event, "bad")).status, 401);
  assert.equal((await deliver(event)).status, 200);
  assert.equal((await deliver(event)).data.duplicate, true);
  await deliver({ ...event, id: "evt_2", type: "payment_declined" });
  assert.equal((await f.req("/api/order", { token })).data.state, "paid");
  assert.equal(
    (
      await deliver({
        ...event,
        id: "evt_3",
        data: { ...event.data, amount: 1 },
      })
    ).status,
    400,
  );
  assert.equal(
    verifySignature(Buffer.from("test"), "bad", config.CKO_WEBHOOK_SECRET),
    false,
  );
});

test("late capture of an earlier attempt overrides a newer draft and preserves the original quote", () => {
  const order = newOrder({ ...customer, currency: "EUR" });
  order.attempts = [
    {
      id: "old",
      stage: "submitted",
      currency: "HKD",
      amount: 10000,
      paymentStatus: "Declined",
      captured: true,
    },
    { id: "new", stage: "ready", currency: "EUR", amount: 1200 },
  ];
  const result = snapshot(order);
  assert.equal(result.state, "paid");
  assert.equal(result.currency, "HKD");
  assert.equal(result.amount, 10000);
  assert.equal(result.canRetry, false);
});

test("lifecycle logs correlate attempts, deduplicate status polling and exclude request/session/customer secrets", async (t) => {
  let quote,
    status = "Pending";
  const f = await fixture(t, async (url, opt) => {
    if (url.endsWith("/submit"))
      return response(202, {
        id: "pay_logtest",
        status: "Action Required",
        type: "card",
        secret: "response-secret",
      });
    if (url.includes("/payments/"))
      return response(200, {
        id: "pay_logtest",
        reference: quote.reference,
        amount: 10000,
        currency: "HKD",
        metadata: quote.metadata,
        status,
        customer: { name: customer.name, email: customer.email },
      });
    quote = JSON.parse(opt.body);
    return response(201, {
      id: "ps_logtest",
      payment_session_secret: "private-session",
    });
  });
  const { token } = (await f.order()).data;
  const a = (await f.req("/api/sessions", { method: "POST", body: {}, token }))
    .data;
  await f.req("/api/submit", {
    method: "POST",
    token,
    body: { attemptId: a.attemptId, sessionData: "private-submit-token" },
  });
  await f.req("/api/order", { token });
  await f.req("/api/order", { token });
  status = "Captured";
  await f.req("/api/order", { token });
  assert.deepEqual(
    f.logs
      .filter((x) => x.event === "status_changed")
      .map((x) => x.paymentStatus),
    ["Pending", "Captured"],
  );
  assert.ok(
    f.logs.some(
      (x) => x.event === "submit_returned" && x.status === "Action Required",
    ),
  );
  assert.equal(
    (await f.req("/api/sessions", { method: "POST", body: {}, token })).status,
    409,
  );
  assert.ok(f.logs.some((x) => x.event === "duplicate_blocked"));
  const serialized = JSON.stringify(f.logs);
  for (const secret of [
    token,
    customer.name,
    customer.email,
    config.CKO_SECRET_KEY,
    "private-session",
    "private-submit-token",
    "response-secret",
  ])
    assert.equal(serialized.includes(secret), false);
});

test("provider capture lookup does not claim webhook delivery", async (t) => {
  let quote;
  const f = await fixture(t, async (url, options) => {
    if (url.includes("/payments/"))
      return response(200, {
        id: "pay_capture",
        reference: quote.reference,
        amount: quote.amount,
        currency: quote.currency,
        metadata: quote.metadata,
        status: "Captured",
      });
    if (url.endsWith("/submit"))
      return response(202, { id: "pay_capture", status: "Approved" });
    quote = JSON.parse(options.body);
    return response(201, { id: "ps_capture" });
  });
  const { token } = (await f.order()).data;
  const attempt = (
    await f.req("/api/sessions", { method: "POST", body: {}, token })
  ).data;
  await f.req("/api/submit", {
    method: "POST",
    token,
    body: { attemptId: attempt.attemptId, sessionData: "opaque" },
  });
  const result = (await f.req("/api/order", { token })).data;
  assert.equal(result.state, "paid");
  assert.equal(result.captureWebhookReceived, false);
});

test("reconcile an earlier authorized attempt even with a newer draft", async (t) => {
  let quote;
  const lookups = [];
  const f = await fixture(t, async (url, options) => {
    if (url.includes("/payments/")) {
      lookups.push(url);
      return response(200, {
        id: "pay_earlier",
        reference: quote.reference,
        amount: quote.amount,
        currency: quote.currency,
        metadata: quote.metadata,
        status: "Captured",
      });
    }
    if (url.endsWith("/submit"))
      return response(201, { id: "pay_earlier", status: "Declined" });
    const body = JSON.parse(options.body);
    quote ||= body;
    return response(201, { id: "ps_example" });
  });
  const { token } = (await f.order()).data;
  const first = (
    await f.req("/api/sessions", { method: "POST", body: {}, token })
  ).data;
  await f.req("/api/submit", {
    method: "POST",
    token,
    body: { attemptId: first.attemptId, sessionData: "opaque" },
  });
  await f.req("/api/sessions", { method: "POST", body: {}, token });
  const event = {
    id: "evt_late",
    type: "payment_approved",
    data: {
      id: "pay_earlier",
      reference: quote.reference,
      amount: quote.amount,
      currency: quote.currency,
      metadata: quote.metadata,
    },
  };
  await f.req("/webhooks/checkout", {
    method: "POST",
    body: event,
    headers: {
      "cko-signature": createHmac("sha256", config.CKO_WEBHOOK_SECRET)
        .update(JSON.stringify(event))
        .digest("hex"),
    },
  });
  const result = (await f.req("/api/order", { token })).data;
  assert.equal(lookups.length, 1);
  assert.ok(lookups[0].endsWith("/pay_earlier"));
  assert.equal(result.state, "paid");
  assert.equal(result.canRetry, false);
});

test("risk screening defaults on and can be disabled explicitly for sandbox tests", () => {
  const order = newOrder(customer);
  assert.equal(
    sessionPayload(order, { id: "attempt" }, config).risk.enabled,
    true,
  );
  assert.equal(
    sessionPayload(
      order,
      { id: "attempt" },
      { ...config, ENABLE_RISK: "false" },
    ).risk.enabled,
    false,
  );
});
