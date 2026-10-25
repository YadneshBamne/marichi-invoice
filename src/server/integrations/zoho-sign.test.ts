import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseZohoSignWebhook, zohoSignEsign } from "./zoho-sign";

const pdf = Buffer.from("%PDF-1.4 test");
const read = async () => ({ bytes: pdf });
const req = { idempotencyKey: "agr-1", documentRef: "abc.pdf", signer: "seller@x.com" };
const NAME = "Marichi agreement agr-1";
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status });
const created = { code: 0, status: "success", requests: {
  request_id: "100000000000012345", request_status: "draft", request_name: NAME,
  document_ids: [{ document_id: "200000000000000001", total_pages: 3 }],
  actions: [{ action_id: "300000000000000001", recipient_name: "seller", recipient_email: "seller@x.com" }],
} };

/** Routes by method and path, like the real API. `list` is what the name lookup answers. */
function stub(list: unknown[] = []) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("/oauth/v2/token")) return json({ access_token: "AT1", expires_in: 3600 });
    if (url.includes("/submit")) return json({ code: 0, status: "success", message: "Document has been sent" });
    if (init?.method === "POST") return json(created);
    return json({ code: 0, status: "success", requests: list });
  });
}
const mk = (f: unknown, dc: "in" | "com" | "eu" = "com") =>
  zohoSignEsign({ clientId: "cid", clientSecret: "sec", refreshToken: "rt", dc, readDocument: read, fetch: f as typeof fetch });
const calls = (f: ReturnType<typeof stub>) => f.mock.calls as unknown as [string, RequestInit][];

afterEach(() => vi.useRealTimers());

describe("Zoho Sign e-sign adapter", () => {
  it("refreshes the token, creates the request as multipart, submits it with a signature field, and returns Zoho's id", async () => {
    const f = stub();
    expect(await mk(f).request(req)).toEqual({ requestId: "100000000000012345" });
    const [tok, find, create, submit] = calls(f);

    expect(tok[0]).toBe("https://accounts.zoho.com/oauth/v2/token");
    expect(tok[1].method).toBe("POST");
    const t = new URLSearchParams(tok[1].body as string);
    expect(Object.fromEntries(t)).toEqual({ client_id: "cid", client_secret: "sec", refresh_token: "rt", grant_type: "refresh_token" });

    const auth = { authorization: "Zoho-oauthtoken AT1" };
    expect(find[0]).toMatch(/^https:\/\/sign\.zoho\.com\/api\/v1\/requests\?data=/);
    expect(find[1].headers).toMatchObject(auth);
    expect(JSON.parse(new URL(find[0]).searchParams.get("data")!).page_context.search_columns).toEqual({ request_name: NAME });

    expect(create[0]).toBe("https://sign.zoho.com/api/v1/requests");
    expect(create[1].method).toBe("POST");
    expect(create[1].headers).toMatchObject(auth);
    expect((create[1].headers as Record<string, string>)["content-type"]).toBeUndefined(); // fetch adds the multipart boundary
    const form = create[1].body as FormData;
    const file = form.get("file") as File;
    expect(Buffer.from(await file.arrayBuffer())).toEqual(pdf);
    const data = JSON.parse(form.get("data") as string).requests;
    expect(data.request_name).toBe(NAME);
    expect(data.is_sequential).toBe(true);
    expect(data.actions).toEqual([expect.objectContaining({ action_type: "SIGN", recipient_email: "seller@x.com", recipient_name: "seller" })]);

    expect(submit[0]).toBe("https://sign.zoho.com/api/v1/requests/100000000000012345/submit");
    expect(submit[1].method).toBe("POST");
    expect(submit[1].headers).toMatchObject({ ...auth, "content-type": "application/x-www-form-urlencoded" });
    const act = JSON.parse(new URLSearchParams(submit[1].body as string).get("data")!).requests.actions[0];
    expect(act).toMatchObject({ action_id: "300000000000000001", action_type: "SIGN" });
    expect(act.fields).toEqual([expect.objectContaining({ field_type_name: "Signature", document_id: "200000000000000001", page_no: 2, is_mandatory: true })]);
  });

  it("uses the regional hosts", async () => {
    for (const dc of ["in", "eu"] as const) {
      const f = stub();
      await mk(f, dc).request(req);
      expect(calls(f)[0][0]).toBe(`https://accounts.zoho.${dc}/oauth/v2/token`);
      expect(calls(f)[1][0]).toMatch(new RegExp(`^https://sign\\.zoho\\.${dc}/api/v1/requests`));
    }
  });

  it("keeps the token until a minute before it expires, then refreshes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const f = stub();
    const e = mk(f);
    const tokens = () => calls(f).filter((c) => c[0].includes("/oauth/")).length;
    await e.request(req);
    await e.request({ ...req, idempotencyKey: "agr-2" });
    expect(tokens()).toBe(1);
    vi.setSystemTime(new Date("2026-01-01T00:59:30Z")); // inside the last minute
    await e.request(req);
    expect(tokens()).toBe(2);
  });

  it("is idempotent: an existing request with the same name is returned and nothing is created", async () => {
    const f = stub([{ request_id: "555", request_name: NAME, request_status: "inprogress" }, { request_id: "556", request_name: NAME + " 2" }]);
    expect(await mk(f).request(req)).toEqual({ requestId: "555" });
    expect(calls(f).filter((c) => c[1]?.method === "POST" && !c[0].includes("/oauth/"))).toHaveLength(0);
  });

  it("finishes sending a draft that an earlier try created but never submitted", async () => {
    const f = stub([{ ...created.requests }]);
    expect(await mk(f).request(req)).toEqual({ requestId: "100000000000012345" });
    const posts = calls(f).filter((c) => c[1]?.method === "POST" && !c[0].includes("/oauth/"));
    expect(posts.map((c) => c[0])).toEqual(["https://sign.zoho.com/api/v1/requests/100000000000012345/submit"]);
  });

  it("keeps a numeric request id exact", async () => {
    const f = vi.fn(async (url: string, init?: RequestInit) =>
      url.includes("/oauth/") ? json({ access_token: "A", expires_in: 3600 })
      : url.includes("/submit") ? json({ code: 0, status: "success" })
      : init?.method === "POST" ? new Response(JSON.stringify(created).replace('"request_id":"100000000000012345"', '"request_id":100000000000012345'))
      : json({ code: 0, status: "success", requests: [] }));
    expect(await mk(f).request(req)).toEqual({ requestId: "100000000000012345" });
  });

  it("throws plain errors: bad token, non-2xx, status other than success, missing request id", async () => {
    const badTok = vi.fn(async () => json({ error: "invalid_code" }));
    await expect(mk(badTok).request(req)).rejects.toThrow(/invalid_code/);

    const ok = (create: () => Response) => vi.fn(async (url: string, init?: RequestInit) =>
      url.includes("/oauth/") ? json({ access_token: "A", expires_in: 3600 }) : init?.method === "POST" ? create() : json({ status: "success", requests: [] }));
    await expect(mk(ok(() => json({ code: 4000, status: "failure", message: "Invalid scope" }, 400))).request(req)).rejects.toThrow(/Invalid scope|400/);
    await expect(mk(ok(() => json({ code: 9040, status: "failure", message: "Quota exhausted" }))).request(req)).rejects.toThrow(/Quota exhausted/); // 200 but not success
    await expect(mk(ok(() => new Response("gateway down", { status: 502 }))).request(req)).rejects.toThrow(/502/);
    await expect(mk(ok(() => json({ code: 0, status: "success", requests: {} }))).request(req)).rejects.toThrow(/no request id/);
  });
});

const secret = "whsec";
const sign = (body: string, key = secret) => createHmac("sha256", key).update(body).digest("base64");
const event = (op: string, id: string | number = "100000000000012345") => JSON.stringify({
  requests: { request_id: id, request_name: NAME },
  notifications: { operation_type: op, performed_by_email: "seller@x.com", ip_address: "203.0.113.9", performed_at: 1 },
});
const H = "x-zs-webhook-signature";

describe("Zoho Sign webhook", () => {
  it("accepts a completed event with a valid signature (header object or Headers), keeping the id exact even as a number", () => {
    const want = { requestId: "100000000000012345", outcome: "signed", signer: { email: "seller@x.com", ip: "203.0.113.9" } };
    const body = event("RequestCompleted");
    expect(parseZohoSignWebhook(body, { "X-ZS-WEBHOOK-SIGNATURE": sign(body) }, secret)).toEqual(want);
    expect(parseZohoSignWebhook(body, new Headers({ [H]: sign(body) }), secret)).toEqual(want);
    const num = body.replace('"100000000000012345"', "100000000000012345"); // a bare number, as Zoho's docs call it a long
    expect(parseZohoSignWebhook(num, { [H]: sign(num) }, secret)).toEqual(want);
  });
  it("maps rejected, recalled and expired to failed", () => {
    for (const op of ["RequestRejected", "RequestRecalled", "RequestExpired"]) {
      const body = event(op);
      expect(parseZohoSignWebhook(body, { [H]: sign(body) }, secret)).toEqual({ requestId: "100000000000012345", outcome: "failed", signer: undefined });
    }
  });
  it("rejects a tampered body, a wrong or missing signature, and an empty secret", () => {
    const body = event("RequestCompleted");
    const sig = sign(body);
    expect(() => parseZohoSignWebhook(body.replace("12345", "99999"), { [H]: sig }, secret)).toThrow(/signature/);
    expect(() => parseZohoSignWebhook(body, { [H]: sign(body, "other") }, secret)).toThrow(/signature/);
    expect(() => parseZohoSignWebhook(body, {}, secret)).toThrow(/signature/);
    expect(() => parseZohoSignWebhook(body, { [H]: sign(body, "") }, "")).toThrow(/signature/);
  });
  it("returns null for events it does not act on, so the route can still answer 200", () => {
    for (const op of ["RequestSubmitted", "RequestViewed", "RequestSigningSuccess", "RequestForwarded", "SomethingNew"]) {
      const body = event(op);
      expect(parseZohoSignWebhook(body, { [H]: sign(body) }, secret)).toBeNull();
    }
  });
});
