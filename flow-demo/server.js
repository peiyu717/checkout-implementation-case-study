import express from "express";
import { createPaymentLogger } from "./payment-log.js";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  catalog,
  locales,
  countryCodes,
  countries,
  AppError,
  settings,
  newOrder,
  sessionPayload,
  verifySignature,
  phase,
  mayCreateAttempt,
  snapshot,
} from "./domain.js";

export function createApp(env = process.env, fetchImpl = fetch, options = {}) {
  const config = {
    ...env,
    APP_URL: (env.APP_URL || "http://localhost:3000").replace(/\/$/, ""),
    CKO_API_BASE: (
      env.CKO_API_BASE || "https://api.sandbox.checkout.com"
    ).replace(/\/$/, ""),
  };
  if (
    !/^https:\/\/(?:[a-z0-9-]+\.)?api\.sandbox\.checkout\.com$/.test(
      config.CKO_API_BASE,
    )
  )
    throw Error("Sandbox API required");
  const origin = new URL(config.APP_URL).origin;
  if (
    new URL(config.APP_URL).pathname !== "/" ||
    (!origin.startsWith("https://") &&
      !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin))
  )
    throw Error("HTTPS or localhost APP_URL required");
  // Deliberately no database. A restart loses order capabilities; never silently start a replacement payment.
  const orders = new Map(),
    creationKeys = new Map(),
    events = new Set();
  // Injected logger keeps test traffic separate; the executable server enables private local logs.
  const log = options.logger || (() => {});
  const context = (order, a = order?.attempts.at(-1)) => ({
    reference: order?.reference,
    attemptId: a?.id,
    paymentId: a?.paymentId,
    amount: a?.amount ?? catalog[order?.settings.currency],
    currency: a?.currency ?? order?.settings.currency,
    paymentStatus: a?.captured ? "Captured" : a?.paymentStatus,
  });
  const app = express();
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.set({
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
      "Permissions-Policy": "camera=(), microphone=()",
    });
    next();
  });
  async function cko(path, body) {
    let r;
    try {
      r = await fetchImpl(config.CKO_API_BASE + path, {
        method: body ? "POST" : "GET",
        headers: {
          Authorization: `Bearer ${config.CKO_SECRET_KEY}`,
          "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(20000),
      });
    } catch {
      throw new AppError(502, "upstream_unavailable");
    }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const e = new AppError(502, "upstream_rejected");
      e.upstreamStatus = r.status;
      throw e;
    }
    return data;
  }
  const authorize = (req, res, next) => {
    const order = orders.get(req.get("X-Order-Token"));
    if (!order) {
      log("request_rejected", {
        level: "warn",
        errorCode: "order_unavailable",
        httpStatus: 404,
      });
      return res.status(404).json({ error: "order_unavailable" });
    }
    req.order = order;
    next();
  };
  const sameOrigin = (req, res, next) => {
    if (req.get("Origin") === origin) return next();
    log("request_rejected", {
      level: "warn",
      errorCode: "origin_not_allowed",
      httpStatus: 403,
    });
    res.status(403).json({ error: "origin_not_allowed" });
  };
  const asyncRoute = (fn) => (req, res, next) =>
    Promise.resolve(fn(req, res)).catch(next);
  function requireEditable(order) {
    if (mayCreateAttempt(order)) return;
    log("duplicate_blocked", {
      ...context(order),
      level: "warn",
      errorCode: "payment_locked",
    });
    throw new AppError(409, "payment_locked");
  }
  function bindPayment(order, p) {
    // URL/payment IDs are hints, not authorization. Match the server reference AND attempt quote.
    const a = order.attempts.find(
      (x) => x.id === p.metadata?.attempt_id || x.paymentId === p.id,
    );
    if (
      !a ||
      p.reference !== order.reference ||
      p.amount !== a.amount ||
      p.currency !== a.currency ||
      !/^pay_\w+$/.test(p.id || "")
    )
      throw new AppError(404, "payment_mismatch");
    if (a.paymentId && a.paymentId !== p.id)
      throw new AppError(409, "payment_mismatch");
    const previousStatus = phase(a);
    a.paymentId = p.id;
    // Capture is monotonic. Late Pending/approval/decline observations cannot undo it.
    if (p.status === "Captured") a.captured = true;
    a.paymentStatus = p.status;
    a.stage = "submitted";
    if (previousStatus !== phase(a))
      log("status_changed", {
        ...context(order, a),
        previousStatus,
        status: phase(a),
      });
    return a;
  }
  // Raw bytes BEFORE JSON parsing; a webhook signing key is distinct from the API key.
  app.post(
    "/webhooks/checkout",
    express.raw({ type: "application/json", limit: "64kb" }),
    asyncRoute(async (req, res) => {
      if (!config.CKO_WEBHOOK_SECRET) {
        log("webhook_not_configured", { level: "warn", httpStatus: 503 });
        return res.status(503).json({ error: "webhook_not_configured" });
      }
      if (
        !Buffer.isBuffer(req.body) ||
        !verifySignature(
          req.body,
          req.get("cko-signature"),
          config.CKO_WEBHOOK_SECRET,
        )
      ) {
        log("webhook_rejected", {
          level: "warn",
          errorCode: "invalid_signature",
          httpStatus: 401,
        });
        return res.status(401).json({ error: "invalid_signature" });
      }
      let e;
      try {
        e = JSON.parse(req.body);
      } catch {
        throw new AppError(400, "invalid_event");
      }
      if (
        typeof e.id !== "string" ||
        typeof e.type !== "string" ||
        !e.data ||
        typeof e.data.id !== "string"
      )
        throw new AppError(400, "invalid_event");
      if (events.has(e.id)) {
        log("webhook_duplicate", { eventId: e.id, webhookType: e.type });
        return res.json({ received: true, duplicate: true });
      }
      if (
        !["payment_approved", "payment_captured", "payment_declined"].includes(
          e.type,
        )
      )
        return res.json({ received: true, ignored: true });
      const order = [...orders.values()].find(
        (o) => o.reference === e.data.reference,
      );
      if (order) {
        const a = order.attempts.find(
          (x) =>
            x.paymentId === e.data.id || x.id === e.data.metadata?.attempt_id,
        );
        if (!a || a.amount !== e.data.amount || a.currency !== e.data.currency)
          throw new AppError(400, "event_mismatch");
        if (a.paymentId && a.paymentId !== e.data.id)
          throw new AppError(400, "event_mismatch");
        const previousStatus = phase(a);
        a.paymentId = e.data.id;
        a.stage = "submitted";
        if (e.type === "payment_captured") {
          a.captured = true;
          a.captureWebhookReceived = true;
        }
        if (!a.captured)
          a.paymentStatus =
            e.type === "payment_approved" ? "Authorized" : "Declined";
        log("webhook_received", {
          ...context(order, a),
          eventId: e.id,
          webhookType: e.type,
        });
        if (previousStatus !== phase(a))
          log("status_changed", {
            ...context(order, a),
            previousStatus,
            status: phase(a),
          });
      }
      if (!order)
        log("webhook_unmatched", { eventId: e.id, webhookType: e.type });
      if (events.size < 10000) events.add(e.id);
      res.json({ received: true });
    }),
  );
  app.use("/api", express.json({ limit: "32kb", strict: true }));
  app.get("/api/config", (req, res) =>
    res.json({
      publicKey: config.CKO_PUBLIC_KEY || "",
      configured: !!(
        config.CKO_PUBLIC_KEY &&
        config.CKO_SECRET_KEY &&
        config.CKO_PROCESSING_CHANNEL_ID
      ),
      catalog,
      locales,
      countries: countryCodes.map((code) => ({
        code,
        name: countries.of(code),
      })),
      applePayEnabled: config.ENABLE_APPLE_PAY === "true",
    }),
  );
  app.post("/api/orders", sameOrigin, (req, res, next) => {
    try {
      const key = req.get("X-Create-Key");
      if (!/^[a-f\d-]{36}$/i.test(key || ""))
        throw new AppError(400, "creation_key_required");
      const prior = creationKeys.get(key);
      if (prior) {
        log("order_reused", context(prior));
        return res.json({ token: prior.token, order: snapshot(prior) });
      }
      if (orders.size >= 2000) throw new AppError(429, "demo_capacity");
      const order = newOrder(settings(req.body));
      orders.set(order.token, order);
      creationKeys.set(key, order);
      log("order_created", context(order));
      res.status(201).json({ token: order.token, order: snapshot(order) });
    } catch (e) {
      next(e);
    }
  });
  // Changes before payment invalidate the previous local attempt; no promise of remotely revoking sessions.
  // Superseded sessions cannot submit through our backend handleSubmit route.
  app.post("/api/settings", sameOrigin, authorize, (req, res, next) => {
    try {
      const order = req.order;
      requireEditable(order);
      order.settings = settings(req.body);
      for (const a of order.attempts)
        if (a.stage === "ready") a.stage = "superseded";
      log("settings_updated", context(order));
      res.json(snapshot(order));
    } catch (e) {
      next(e);
    }
  });
  app.post(
    "/api/sessions",
    sameOrigin,
    authorize,
    asyncRoute(async (req, res) => {
      if (
        !config.CKO_PUBLIC_KEY ||
        !config.CKO_SECRET_KEY ||
        !config.CKO_PROCESSING_CHANNEL_ID
      )
        throw new AppError(503, "configuration_required");
      const order = req.order;
      requireEditable(order);
      if (order.attempts.length >= 30) throw new AppError(429, "attempt_limit");
      order.busy = true;
      const attempt = {
        id: randomUUID(),
        amount: catalog[order.settings.currency],
        currency: order.settings.currency,
        stage: "creating",
      };
      for (const a of order.attempts)
        if (a.stage === "ready") a.stage = "superseded";
      order.attempts.push(attempt);
      if (
        order.attempts
          .slice(0, -1)
          .some((a) => ["failed", "cancelled"].includes(phase(a)))
      )
        log("retry_requested", {
          ...context(order, attempt),
          attemptCount: order.attempts.length,
        });
      log("session_requested", context(order, attempt));
      try {
        const session = await cko(
          "/payment-sessions",
          sessionPayload(order, attempt, config),
        );
        if (typeof session.id !== "string" || !session.id.startsWith("ps_"))
          throw new AppError(502, "invalid_session_response");
        attempt.sessionId = session.id;
        attempt.stage = "ready";
        log("session_created", context(order, attempt));
        // Send the unmodified session to Flow; never retain or log its secret/token.
        res
          .status(201)
          .json({ session, attemptId: attempt.id, order: snapshot(order) });
      } catch (e) {
        attempt.stage = "preflight_failed";
        log("session_failed", {
          ...context(order, attempt),
          level: "error",
          errorCode: e.code,
          upstreamStatus: e.upstreamStatus,
        });
        throw e;
      } finally {
        order.busy = false;
      }
    }),
  );
  app.post(
    "/api/submit",
    sameOrigin,
    authorize,
    asyncRoute(async (req, res) => {
      const order = req.order;
      if (
        Object.keys(req.body || {}).some(
          (k) => !["attemptId", "sessionData"].includes(k),
        ) ||
        typeof req.body?.sessionData !== "string" ||
        req.body.sessionData.length > 24000
      )
        throw new AppError(400, "invalid_submission");
      const a = order.attempts.at(-1);
      if (
        !a ||
        a.id !== req.body.attemptId ||
        a.stage !== "ready" ||
        order.busy ||
        !mayCreateAttempt(order)
      ) {
        log("duplicate_blocked", {
          ...context(order),
          level: "warn",
          errorCode: "payment_locked",
        });
        throw new AppError(409, "payment_locked");
      }
      // Lock synchronously before awaiting. No automatic upstream payment retries.
      a.stage = "submitting";
      order.busy = true;
      log("submit_started", context(order, a));
      try {
        const payment = await cko(
          `/payment-sessions/${encodeURIComponent(a.sessionId)}/submit`,
          { session_data: req.body.sessionData },
        );
        if (!/^pay_\w+$/.test(payment.id || ""))
          throw new AppError(502, "invalid_payment_response");
        a.paymentId = payment.id;
        a.stage = "submitted";
        // Submission's Approved/Action Required are not captured status. Retrieve authoritative details separately.
        if (payment.status === "Declined") a.paymentStatus = "Declined";
        log("submit_returned", {
          ...context(order, a),
          status: payment.status,
        });
        res.json(payment); // Flow contract requires this exact unmodified body, including authentication actions.
      } catch (e) {
        // Definitive request validation/auth rejection did not create a payment. All ambiguous transport/5xx outcomes stay locked.
        a.stage = [400, 401, 403, 415, 422].includes(e.upstreamStatus)
          ? "preflight_failed"
          : "unknown";
        log("submit_failed", {
          ...context(order, a),
          level: "error",
          status: a.stage,
          errorCode: e.code,
          upstreamStatus: e.upstreamStatus,
        });
        throw e;
      } finally {
        order.busy = false;
      }
    }),
  );
  app.get(
    "/api/order",
    authorize,
    asyncRoute(async (req, res) => {
      const order = req.order,
        hint = req.query.paymentId;
      if (hint && !/^pay_\w+$/.test(hint))
        throw new AppError(400, "invalid_payment_id");
      const current = snapshot(order);
      const a = order.attempts.find((item) => item.id === current.attemptId),
        id = hint || a?.paymentId;
      if (id) {
        try {
          bindPayment(order, await cko(`/payments/${encodeURIComponent(id)}`));
        } catch (e) {
          log("status_lookup_failed", {
            ...context(order, a),
            level: "warn",
            errorCode: e.code,
            upstreamStatus: e.upstreamStatus,
          });
          if (e.code === "payment_mismatch" || e.code === "invalid_payment_id")
            throw e;
          return res.json({
            ...snapshot(order),
            lookupUnavailable: true,
            canRetry: false,
            state: current.state === "paid" ? "paid" : "confirming",
          });
        }
      }
      res.json(snapshot(order));
    }),
  );
  // Only public files are exposed; environment variables/source/tests are never served.
  const publicPath = fileURLToPath(new URL("./public/", import.meta.url));
  app.use(express.static(publicPath, { index: "index.html", etag: false }));
  app.get("/result", (req, res) => res.sendFile(`${publicPath}index.html`));
  app.use((req, res) => res.status(404).json({ error: "not_found" }));
  app.use((e, req, res, next) => {
    if (res.headersSent) return next(e);
    log("request_rejected", {
      ...context(req.order),
      level: "warn",
      errorCode: e.code || "request_invalid",
      httpStatus: e.status || 400,
    });
    res.status(e.status || 400).json({ error: e.code || "request_invalid" });
  });
  return app;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  const logger = createPaymentLogger({
    directory: fileURLToPath(new URL("./logs/", import.meta.url)),
  });
  createApp(process.env, fetch, { logger }).listen(port, "127.0.0.1", () => {
    console.log(`Sandbox checkout ready on port ${port}`);
    logger("server_started");
  });
}
