import { translations } from "./translations.js";
const $ = (id) => document.getElementById(id);
let config,
  flow,
  order,
  attemptId,
  busy = false,
  locked = false,
  pollTimer,
  polls = 0;
let token = sessionStorage.getItem("case.orderToken");
let locale = sessionStorage.getItem("case.locale") || "en-GB";
if (!translations[locale]) locale = "en-GB";
let statusKey = "",
  createKey = sessionStorage.getItem("case.createKey") || crypto.randomUUID();
sessionStorage.setItem("case.createKey", createKey);
const t = (key) =>
  translations[locale][key] || translations["en-GB"][key] || key;
function message(key, state = "") {
  statusKey = key;
  $("status").textContent = t(key);
  $("status").dataset.state = state;
}
function renderText() {
  document.documentElement.lang = locale;
  $("locale").value = locale;
  document
    .querySelectorAll("[data-i18n]")
    .forEach((el) => (el.textContent = t(el.dataset.i18n)));
  if (statusKey) $("status").textContent = t(statusKey);
  if (config) {
    const currencyNames = new Intl.DisplayNames([locale], { type: "currency" });
    [...$("currency").options].forEach(
      (option) =>
        (option.textContent = `${option.value} — ${currencyNames.of(option.value)}`),
    );
    const selected = $("country").value;
    const dn = new Intl.DisplayNames([locale], { type: "region" });
    $("country").replaceChildren(
      new Option(t("chooseCountry"), ""),
      ...config.countries.map((c) => new Option(dn.of(c.code), c.code)),
    );
    $("country").value = selected;
    price();
  }
  if (order)
    $("reference").textContent = `${t("reference")}: ${order.reference}`;
}
function price() {
  const currency = $("currency").value;
  $("total").textContent = new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
  }).format(
    (order?.currency === currency && locked
      ? order.amount
      : config.catalog[currency]) / 100,
  );
}
async function api(path, { method = "GET", body, headers = {} } = {}) {
  const r = await fetch(path, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { "X-Order-Token": token } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const data = await r.json();
  if (!r.ok) {
    const e = new Error(data.error || "unavailable");
    e.code = data.error;
    e.status = r.status;
    throw e;
  }
  return data;
}
function controls() {
  $("settings").disabled = busy || locked;
  $("locale").disabled = busy || locked;
  $("continue").disabled = busy || locked;
}
function unmount() {
  try {
    flow?.unmount();
  } catch {}
  flow = null;
  $("flow-container").replaceChildren();
}
function input() {
  return {
    currency: $("currency").value,
    billingCountry: $("country").value,
    name: $("name").value,
    email: $("email").value,
    locale,
  };
}
function showError(e) {
  const map = {
    order_unavailable: "lost",
    configuration_required: "configuration",
    invalid_settings: "invalid",
    invalid_customer: "invalid",
    payment_locked: "locked",
  };
  const key = map[e.code] || "unavailable";
  if (key === "lost") {
    locked = true;
    $("continue").hidden = true;
  }
  message(key, key === "lost" ? "lost" : "");
  controls();
}
// All result rendering is driven by our server's verified state, never URL status flags.
function renderOrder(data) {
  order = data;
  locked = !data.canRetry;
  busy = false;
  $("currency").value = data.currency;
  controls();
  renderText();
  $("check").hidden = ![
    "confirming",
    "pending",
    "authorized",
    "failed",
    "cancelled",
    "paid",
  ].includes(data.state);
  $("new-order").hidden = data.state !== "paid";
  $("back").hidden = !["failed", "cancelled"].includes(data.state);
  $("continue").hidden =
    !!flow || locked || ["paid", "failed", "cancelled"].includes(data.state);
  if (
    [
      "paid",
      "authorized",
      "pending",
      "confirming",
      "failed",
      "cancelled",
    ].includes(data.state)
  ) {
    unmount();
    message(data.state, data.state);
  }
  if (["pending", "authorized", "confirming"].includes(data.state))
    schedulePoll();
}
function schedulePoll() {
  clearTimeout(pollTimer);
  if (polls >= 12) {
    message("maxPoll", "confirming");
    return;
  }
  pollTimer = setTimeout(() => {
    polls++;
    refresh();
  }, 2500);
}
async function refresh(hint) {
  try {
    const data = await api(
      `/api/order${hint ? "?paymentId=" + encodeURIComponent(hint) : ""}`,
    );
    renderOrder(data);
    return data;
  } catch (e) {
    if (e.code === "order_unavailable") showError(e);
    else {
      locked = true;
      busy = false;
      controls();
      message("confirming", "confirming");
      $("check").hidden = false;
    }
  }
}
// Changing settings unmounts old card inputs; creates a new matching session on Continue.
// An unmounted session is not claimed to be remotely revoked. Backend rejects its superseded attempt.
async function changed() {
  if (busy || locked) return;
  unmount();
  $("continue").hidden = false;
  message("changed");
  price();
  // Save a valid change immediately to reject stale submissions from another tab/component.
  if (token && $("details").checkValidity()) {
    busy = true;
    controls();
    try {
      order = await api("/api/settings", { method: "POST", body: input() });
    } catch (e) {
      showError(e);
    } finally {
      busy = false;
      controls();
    }
  }
}
$("currency").addEventListener("change", changed);
$("country").addEventListener("change", changed);
$("name").addEventListener("input", () => {
  if (flow) changed();
});
$("email").addEventListener("input", () => {
  if (flow) changed();
});
$("locale").addEventListener("change", async () => {
  locale = $("locale").value;
  sessionStorage.setItem("case.locale", locale);
  renderText();
  await changed();
});
$("details").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy || locked) return;
  busy = true;
  controls();
  message("loading");
  clearTimeout(pollTimer);
  polls = 0;
  try {
    if (!config.configured)
      throw Object.assign(new Error(), { code: "configuration_required" });
    if (!window.CheckoutWebComponents) {
      message("library");
      return;
    }
    const customer = input();
    if (!token) {
      const created = await api("/api/orders", {
        method: "POST",
        body: customer,
        headers: { "X-Create-Key": createKey },
      });
      token = created.token;
      order = created.order;
      sessionStorage.setItem("case.orderToken", token);
    } else
      order = await api("/api/settings", { method: "POST", body: customer });
    const prepared = await api("/api/sessions", { method: "POST", body: {} });
    order = prepared.order;
    attemptId = prepared.attemptId;
    renderText();
    unmount();
    const checkout = await window.CheckoutWebComponents({
      publicKey: config.publicKey,
      environment: "sandbox",
      locale,
      paymentSession: prepared.session,
      appearance: {
        colorAction: "#323416",
        colorPrimary: "#323416",
        colorBackground: "#FFFFFD",
      },
      componentOptions: {
        card: {
          displayCardholderName: "top",
          data: { cardholderName: customer.name },
        },
      },
      onReady: () => {
        message("ready");
      },
      // Lock settings as soon as submission starts; Flow handles local validation.
      onSubmit: () => {
        busy = true;
        controls();
        message("submitting");
      },
      // The official custom submission hook receives an opaque token, never raw PAN/CVV.
      // Backend saves payment ID before this response, enabling reconciliation after a browser timeout.
      handleSubmit: async (_component, data) => {
        busy = true;
        locked = true;
        controls();
        message("submitting");
        try {
          return await api("/api/submit", {
            method: "POST",
            body: { attemptId, sessionData: data.session_data },
          });
        } catch {
          await refresh();
          return undefined;
        }
      },
      onPaymentCompleted: async (_component, payment) => {
        history.replaceState(
          {},
          "",
          `/result?cko-payment-id=${encodeURIComponent(payment.id)}`,
        );
        await refresh(payment.id);
      },
      onError: async () => {
        // Do not log the SDK object: it can contain payment/session data. Error alone is not a failed-payment proof.
        const data = await refresh();
        if (data?.state === "ready") {
          busy = false;
          locked = false;
          controls();
          message("localError");
        }
      },
    });
    flow = checkout.create("flow");
    flow.mount("#flow-container");
    $("continue").hidden = true;
  } catch (e) {
    showError(e);
  } finally {
    busy = false;
    controls();
  }
});
$("check").onclick = () => {
  polls = 0;
  refresh();
};
$("back").onclick = () => {
  if (!order?.canRetry) return;
  clearTimeout(pollTimer);
  unmount();
  locked = false;
  busy = false;
  controls();
  $("continue").hidden = false;
  $("back").hidden = true;
  history.replaceState({}, "", "/");
  message("changed");
};
$("new-order").onclick = () => {
  if (order?.state !== "paid" || !confirm(t("newConfirm"))) return;
  sessionStorage.removeItem("case.orderToken");
  sessionStorage.removeItem("case.createKey");
  location.assign("/");
};
// Only non-card correlation/locale values are retained in sessionStorage. No name/email/card data.
try {
  config = await api("/api/config");
  renderText();
  if (token) {
    const hint = new URLSearchParams(location.search).get("cko-payment-id");
    const data = await refresh(hint);
    if (data) {
      $("currency").value = data.currency;
      $("country").value = data.billingCountry;
      price();
      if (data.state === "ready" || data.state === "checkout")
        message("changed");
    }
  } else if (location.pathname === "/result") {
    locked = true;
    $("continue").hidden = true;
    controls();
    message("lost", "lost");
  }
  if (!config.configured) message("configuration");
} catch {
  message("unavailable");
}
