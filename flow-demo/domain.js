import { randomUUID, createHmac, timingSafeEqual } from "node:crypto";

// One fixed case. These independent catalog prices are not an FX conversion.
export const catalog = Object.freeze({ HKD: 10000, EUR: 1200 });
export const locales = ["en-GB", "zh-HK", "nl-NL"];
export const countries = new Intl.DisplayNames(["en"], { type: "region" });
export const countryCodes =
  "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW".split(
    " ",
  );
export class AppError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

// Allowlisted business inputs only. No PAN, CVV, expiry or client price fields.
export function settings(input) {
  if (
    !input ||
    Array.isArray(input) ||
    typeof input !== "object" ||
    Object.keys(input).some(
      (k) =>
        !["currency", "billingCountry", "name", "email", "locale"].includes(k),
    )
  )
    throw new AppError(400, "invalid_settings");
  const { currency, billingCountry, name, email, locale } = input;
  if (
    !Object.hasOwn(catalog, currency) ||
    !countryCodes.includes(billingCountry) ||
    !locales.includes(locale)
  )
    throw new AppError(400, "invalid_settings");
  if (
    typeof name !== "string" ||
    name.trim().length < 2 ||
    name.trim().length > 100 ||
    /[\x00-\x1f]/.test(name)
  )
    throw new AppError(400, "invalid_customer");
  if (
    typeof email !== "string" ||
    email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  )
    throw new AppError(400, "invalid_customer");
  return {
    currency,
    billingCountry,
    name: name.trim(),
    email: email.trim(),
    locale,
  };
}
export function newOrder(config) {
  return {
    token: randomUUID(),
    reference: `CASE-${randomUUID().replaceAll("-", "").slice(0, 24)}`,
    settings: config,
    attempts: [],
    busy: false,
    createdAt: Date.now(),
  };
}
// Reference belongs to the logical order; attempt ID is separate correlation metadata.
export function sessionPayload(order, attempt, config) {
  const s = order.settings;
  return {
    amount: catalog[s.currency],
    currency: s.currency,
    reference: order.reference,
    processing_channel_id: config.CKO_PROCESSING_CHANNEL_ID,
    payment_type: "Regular",
    billing: { address: { country: s.billingCountry } },
    customer: { name: s.name, email: s.email },
    billing_descriptor: { name: "CASE DEMO HK", city: "Hong Kong" },
    description: "One iPhone case",
    items: [
      { name: "iPhone case", quantity: 1, unit_price: catalog[s.currency] },
    ],
    capture: true,
    risk: { enabled: config.ENABLE_RISK !== "false" },
    locale: s.locale,
    // Require 3DS, request a challenge, do not fall back to a non-3DS payment.
    // Authentication is required; the issuer controls the challenge experience.
    "3ds": {
      enabled: true,
      attempt_n3d: false,
      challenge_indicator: "challenge_requested_mandate",
    },
    enabled_payment_methods:
      config.ENABLE_APPLE_PAY === "true" ? ["card", "applepay"] : ["card"],
    success_url: `${config.APP_URL}/result`,
    failure_url: `${config.APP_URL}/result`,
    metadata: { attempt_id: attempt.id },
  };
}
export function verifySignature(raw, signature, secret) {
  if (!secret || !/^[a-fA-F0-9]{64}$/.test(signature || "")) return false;
  return timingSafeEqual(
    createHmac("sha256", secret).update(raw).digest(),
    Buffer.from(signature, "hex"),
  );
}
// Unknown is NOT failed. Authorization prevents another payment while capture is pending.
export function phase(attempt) {
  if (!attempt) return "checkout";
  if (attempt.captured) return "paid";
  const states = {
    Captured: "paid",
    Authorized: "authorized",
    Pending: "pending",
    Declined: "failed",
    Canceled: "cancelled",
    Cancelled: "cancelled",
    Voided: "cancelled",
    Expired: "failed",
  };
  return (
    states[attempt.paymentStatus] ||
    { ready: "ready", preflight_failed: "failed", superseded: "checkout" }[
      attempt.stage
    ] ||
    "confirming"
  );
}
export function mayCreateAttempt(order) {
  return (
    !order.busy &&
    order.attempts.every((a) =>
      ["checkout", "ready", "failed", "cancelled"].includes(phase(a)),
    )
  );
}
export function snapshot(order) {
  // A late capture on any earlier attempt takes precedence over a newer checkout draft.
  const latest =
      order.attempts.find((a) => phase(a) === "paid") ||
      order.attempts.find((a) =>
        ["authorized", "pending", "confirming"].includes(phase(a)),
      ) ||
      order.attempts.at(-1),
    state = phase(latest);
  const resultQuote =
    latest && !["checkout", "ready", "failed", "cancelled"].includes(state);
  return {
    reference: order.reference,
    currency: resultQuote ? latest.currency : order.settings.currency,
    amount: resultQuote ? latest.amount : catalog[order.settings.currency],
    billingCountry: order.settings.billingCountry,
    locale: order.settings.locale,
    state,
    paymentId: latest?.paymentId || null,
    attemptId: latest?.id || null,
    paymentStatus: latest?.paymentStatus || null,
    canRetry: mayCreateAttempt(order),
    captureWebhookReceived: latest?.captureWebhookReceived === true,
  };
}
