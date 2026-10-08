import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const put = vi.fn(async () => ({}));
const get = vi.fn();
vi.mock("@vercel/blob", () => ({ put: (...a: unknown[]) => put(...(a as [])), get: (...a: unknown[]) => get(...a) }));

const PDF = Buffer.from("%PDF-1.4 test invoice");
beforeEach(() => { put.mockClear(); get.mockReset(); });
afterEach(() => { vi.unstubAllEnvs(); });

describe("document vault on Vercel Blob", () => {
  it("stores privately under a content-addressed name, and reads it back", async () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "test-token");
    const { putDocument, readDocument } = await import("./vault");
    const { ref, hash } = await putDocument(PDF, "application/pdf");
    expect(ref).toBe(`${hash}.pdf`);
    expect(put).toHaveBeenCalledWith(`vault/${ref}`, PDF, expect.objectContaining({ access: "private", addRandomSuffix: false, allowOverwrite: true, contentType: "application/pdf" }));

    get.mockResolvedValue({ statusCode: 200, stream: new Response(PDF).body, headers: new Headers(), blob: {} });
    const r = await readDocument(ref);
    expect(get).toHaveBeenCalledWith(`vault/${ref}`, { access: "private" });
    expect(r.contentType).toBe("application/pdf");
    expect(r.bytes.equals(PDF)).toBe(true);
  });

  it("a missing blob is an error, and malformed refs never reach storage", async () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "test-token");
    const { readDocument } = await import("./vault");
    get.mockResolvedValue(null);
    await expect(readDocument(`${"a".repeat(64)}.pdf`)).rejects.toThrow(/not found/);
    await expect(readDocument("../../etc/passwd")).rejects.toThrow(/invalid/);
    await expect(readDocument(`${"a".repeat(64)}.exe`)).rejects.toThrow(/invalid/);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("enforces type and size, including the 4 MB cap that fits Vercel's request limit", async () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "test-token");
    const { putDocument, putLogo } = await import("./vault");
    await expect(putDocument(PDF, "image/svg+xml")).rejects.toThrow(/PDF, PNG or JPEG/);
    await expect(putDocument(Buffer.alloc(4 * 1024 * 1024 + 1), "application/pdf")).rejects.toThrow(/4 MB/);
    await expect(putLogo(Buffer.from("x"), "image/svg+xml")).rejects.toThrow(/PNG, JPEG or WebP/);
    expect(put).not.toHaveBeenCalled();
  });

  it("production without a token fails loudly instead of writing to a temporary disk", async () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
    vi.stubEnv("NODE_ENV", "production");
    const { putDocument } = await import("./vault");
    await expect(putDocument(PDF, "application/pdf")).rejects.toThrow(/BLOB_READ_WRITE_TOKEN/);
  });
});
