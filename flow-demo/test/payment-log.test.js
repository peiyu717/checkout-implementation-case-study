import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPaymentLogger, safeLogEntry } from "../payment-log.js";

test("allowlist discards personal data, all tokens, raw response and malicious values in permitted fields", () => {
  const marker = "sk_sbox_sensitive-value";
  const row = safeLogEntry("submit_failed", {
    reference: marker,
    attemptId: marker,
    paymentId: marker,
    eventId: marker,
    status: marker,
    errorCode: marker,
    amount: marker,
    currency: marker,
    name: marker,
    email: marker,
    cvv: marker,
    number: marker,
    secret: marker,
    session_data: marker,
    sessionData: marker,
    orderToken: marker,
    response: { secret: marker },
    request: { headers: { Authorization: marker } },
  });
  assert.equal(JSON.stringify(row).includes(marker), false);
  assert.equal(safeLogEntry(marker, {}), null);
});
test("JSON Lines file and terminal share safe records; file is private and rotation retains only current + prior file", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "cko-log-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const lines = [];
  const log = createPaymentLogger({
    directory: dir,
    maxBytes: 1,
    onConsole: (line) => lines.push(line),
  });
  log("session_created", { currency: "HKD", amount: 10000 });
  log("submit_returned", {
    paymentId: "pay_logtest",
    status: "Action Required",
  });
  const current = (await readFile(join(dir, "payments.jsonl"), "utf8")).trim();
  const prior = (await readFile(join(dir, "payments.1.jsonl"), "utf8")).trim();
  assert.equal(prior, lines[0]);
  assert.equal(current, lines[1]);
  assert.equal(JSON.parse(current).status, "Action Required");
  assert.equal((await stat(join(dir, "payments.jsonl"))).mode & 0o777, 0o600);
});
test("disk/terminal errors do not propagate into payment handling and emit one generic warning", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "cko-log-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "not-directory");
  await writeFile(file, "test");
  let warnings = 0;
  const log = createPaymentLogger({
    directory: file,
    onConsole: () => {
      throw Error("terminal failed");
    },
    onWarning: () => warnings++,
  });
  assert.doesNotThrow(() => {
    log("submit_started", {});
    log("submit_returned", { status: "Approved" });
  });
  assert.equal(warnings, 1);
});
