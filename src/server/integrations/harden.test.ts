import { beforeEach, describe, expect, it } from "vitest";
import { CircuitOpenError, gatewayStats, harden, resetGatewayStats } from "./harden";
import { mock } from "./mock";
import type { Adapters } from "./gateway";

let t = 0;
const slept: number[] = [];
const opts = { now: () => t, sleep: async (ms: number) => { slept.push(ms); t += ms; }, log: () => {}, timeoutMs: 50 };
/** mock with one scripted method: kyc.verifyTaxId fails `failures` times, then succeeds */
function flaky(failures: number) {
  let n = 0;
  const base = { ...mock, kyc: { ...mock.kyc, verifyTaxId: async () => { n++; if (n <= failures) throw new Error("boom"); return { valid: true, nameMatch: true }; } } } as Adapters;
  return { base, calls: () => n };
}
beforeEach(() => { t = 0; slept.length = 0; resetGatewayStats(); });

describe("gateway hardening", () => {
  it("retries with exponential backoff, then succeeds", async () => {
    const f = flaky(2);
    expect(await harden(f.base, opts).kyc.verifyTaxId("ABCDE1234F", "x")).toEqual({ valid: true, nameMatch: true });
    expect(f.calls()).toBe(3); expect(slept).toEqual([200, 400]);
    expect(gatewayStats().kyc).toMatchObject({ calls: 3, errors: 2 });
  });
  it("gives up after the retries and keeps the error (fail-closed)", async () => {
    const f = flaky(99);
    await expect(harden(f.base, opts).kyc.verifyTaxId("A", "x")).rejects.toThrow("boom");
    expect(f.calls()).toBe(3);
  });
  it("does not retry notify.send", async () => {
    let n = 0;
    const g = harden({ ...mock, notify: { send: async () => { n++; throw new Error("smtp down"); } } } as Adapters, opts);
    await expect(g.notify.send({} as never)).rejects.toThrow("smtp down");
    expect(n).toBe(1);
  });
  it("times out a hung provider", async () => {
    const g = harden({ ...mock, irn: { getIrn: () => new Promise(() => {}) } } as Adapters, { ...opts, retries: 0 });
    await expect(g.irn.getIrn("x")).rejects.toThrow(/timed out/);
  });
  it("opens the circuit after repeated failures, fails fast, then recovers after cool-off", async () => {
    const f = flaky(5); // 5 failures = breakAfter, 6th call would succeed
    const g = harden(f.base, { ...opts, retries: 0 });
    for (let i = 0; i < 5; i++) await expect(g.kyc.verifyTaxId("A", "x")).rejects.toThrow("boom");
    await expect(g.kyc.verifyTaxId("A", "x")).rejects.toBeInstanceOf(CircuitOpenError);
    expect(f.calls()).toBe(5); expect(gatewayStats().kyc.circuit).toBe("open");
    t += 30_000;
    expect((await g.kyc.verifyTaxId("A", "x")).valid).toBe(true);
    expect(gatewayStats().kyc.circuit).toBe("closed");
  });
  it("caches stable lookups for the TTL", async () => {
    const f = flaky(0);
    const g = harden(f.base, opts);
    await g.kyc.verifyTaxId("P", "n"); await g.kyc.verifyTaxId("P", "n");
    expect(f.calls()).toBe(1);
    t += 25 * 3_600_000; await g.kyc.verifyTaxId("P", "n");
    expect(f.calls()).toBe(2);
  });
});
