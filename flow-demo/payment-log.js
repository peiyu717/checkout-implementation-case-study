import { mkdirSync, appendFileSync, statSync, renameSync } from "node:fs";
import { join } from "node:path";

const events = new Set([
  "server_started",
  "order_created",
  "order_reused",
  "settings_updated",
  "session_requested",
  "session_created",
  "session_failed",
  "retry_requested",
  "submit_started",
  "submit_returned",
  "submit_failed",
  "duplicate_blocked",
  "status_changed",
  "status_lookup_failed",
  "request_rejected",
  "webhook_not_configured",
  "webhook_rejected",
  "webhook_duplicate",
  "webhook_received",
  "webhook_unmatched",
]);
const statuses = new Set([
  "Captured",
  "Authorized",
  "Pending",
  "Declined",
  "Canceled",
  "Cancelled",
  "Voided",
  "Expired",
  "Approved",
  "Action Required",
  "checkout",
  "ready",
  "paid",
  "authorized",
  "pending",
  "failed",
  "cancelled",
  "confirming",
  "preflight_failed",
  "unknown",
  "submitting",
  "submitted",
]);
const errors = new Set([
  "upstream_unavailable",
  "upstream_rejected",
  "invalid_session_response",
  "invalid_payment_response",
  "invalid_settings",
  "invalid_customer",
  "creation_key_required",
  "demo_capacity",
  "payment_locked",
  "attempt_limit",
  "configuration_required",
  "invalid_submission",
  "invalid_payment_id",
  "payment_mismatch",
  "event_mismatch",
  "invalid_event",
  "request_invalid",
  "origin_not_allowed",
  "order_unavailable",
  "invalid_signature",
]);

// Construct each log entry from an explicit allowlist, never spread request/response/error data.
// Even opaque session_data, session secrets and order capability tokens must never enter the log.
export function safeLogEntry(event, fields = {}, now = new Date()) {
  if (!events.has(event)) return null;
  const row = {
    time: now.toISOString(),
    level: ["error", "warn"].includes(fields.level) ? fields.level : "info",
    event,
  };
  const patterns = {
    reference: /^CASE-[a-f0-9]{24}$/,
    attemptId: /^[a-f0-9-]{36}$/i,
    paymentId: /^pay_\w{1,64}$/,
    eventId: /^evt_\w{1,80}$/,
  };
  for (const [key, pattern] of Object.entries(patterns))
    if (typeof fields[key] === "string" && pattern.test(fields[key]))
      row[key] = fields[key];
  for (const key of ["status", "previousStatus", "paymentStatus"])
    if (statuses.has(fields[key])) row[key] = fields[key];
  if (["HKD", "EUR"].includes(fields.currency)) row.currency = fields.currency;
  if (
    Number.isSafeInteger(fields.amount) &&
    fields.amount >= 0 &&
    fields.amount <= 1e12
  )
    row.amount = fields.amount;
  if (
    Number.isSafeInteger(fields.attemptCount) &&
    fields.attemptCount >= 0 &&
    fields.attemptCount <= 30
  )
    row.attemptCount = fields.attemptCount;
  for (const key of ["httpStatus", "upstreamStatus"])
    if (
      Number.isInteger(fields[key]) &&
      fields[key] >= 100 &&
      fields[key] <= 599
    )
      row[key] = fields[key];
  if (errors.has(fields.errorCode)) row.errorCode = fields.errorCode;
  if (
    ["payment_approved", "payment_captured", "payment_declined"].includes(
      fields.webhookType,
    )
  )
    row.webhookType = fields.webhookType;
  return row;
}

// Local JSON Lines plus matching terminal output. Logging failure must not fail or retry a payment.
// One rotated file bounds disk growth; this is a debugging trail, not durable order/idempotency storage.
export function createPaymentLogger({
  directory,
  consoleOutput = true,
  maxBytes = 5 * 1024 * 1024,
  onConsole = (line) => console.log(line),
  onWarning = () =>
    console.error("Payment log unavailable; payment handling continues."),
} = {}) {
  let warned = false;
  return (event, fields) => {
    const row = safeLogEntry(event, fields);
    if (!row) return;
    const line = JSON.stringify(row);
    if (directory)
      try {
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        const file = join(directory, "payments.jsonl");
        try {
          if (statSync(file).size >= maxBytes)
            renameSync(file, join(directory, "payments.1.jsonl"));
        } catch (e) {
          if (e.code !== "ENOENT") throw e;
        }
        appendFileSync(file, line + "\n", { mode: 0o600 });
      } catch {
        if (!warned) {
          warned = true;
          try {
            onWarning();
          } catch {}
        }
      }
    if (consoleOutput)
      try {
        onConsole(line);
      } catch {}
  };
}
