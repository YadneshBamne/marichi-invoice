import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { get, put } from "@vercel/blob";

const ALLOWED: Record<string, string> = { "application/pdf": "pdf", "image/png": "png", "image/jpeg": "jpg" };
const MIME: Record<string, string> = { pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", webp: "image/webp", html: "text/html; charset=utf-8", csv: "text/csv; charset=utf-8" };
const LOGO: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" }; // never SVG: it can carry script
// Vercel rejects request bodies over 4.5 MB, so documents stop at 4 MB (the rest of the form needs a little room).
export const MAX_DOC_BYTES = 4 * 1024 * 1024;
const REF = /^[a-f0-9]{64}\.(pdf|png|jpg|webp|html|csv)$/; // the only shape that ever touches a path or a blob name

/**
 * Document vault. Content-addressed, so the same bytes always give the same ref and hash.
 * Storage: Vercel Blob (private) when BLOB_READ_WRITE_TOKEN is set; a local folder for development only.
 * Production without the token is an error, because a serverless disk is temporary and files would silently vanish.
 */
const useBlob = () => Boolean(process.env.BLOB_READ_WRITE_TOKEN);
const dir = () => join(process.cwd(), ".data", "vault");

async function store(bytes: Buffer, ext: string) {
  const hash = createHash("sha256").update(bytes).digest("hex");
  const ref = `${hash}.${ext}`;
  if (useBlob()) {
    // Same bytes -> same name, so overwriting is harmless and a repeat upload is a no-op.
    await put(`vault/${ref}`, bytes, { access: "private", addRandomSuffix: false, allowOverwrite: true, contentType: MIME[ext] });
  } else {
    if (process.env.NODE_ENV === "production") throw new Error("document storage is not configured: set BLOB_READ_WRITE_TOKEN");
    await mkdir(dir(), { recursive: true });
    await writeFile(join(dir(), ref), bytes);
  }
  return { ref, hash };
}

/** User-uploaded invoice file. */
export async function putDocument(bytes: Buffer, mime: string) {
  const ext = ALLOWED[mime];
  if (!ext) throw new Error("only PDF, PNG or JPEG files are accepted");
  if (bytes.length === 0 || bytes.length > MAX_DOC_BYTES) throw new Error("the file must be between 1 byte and 4 MB");
  return store(bytes, ext);
}

/** A bank statement as the bank gave it: a PDF, or the CSV export. */
export async function putStatementFile(bytes: Buffer, kind: "pdf" | "csv") {
  if (bytes.length === 0 || bytes.length > MAX_DOC_BYTES) throw new Error("the file must be between 1 byte and 4 MB");
  return store(bytes, kind);
}

/** Company picture. Small raster images only. */
export async function putLogo(bytes: Buffer, mime: string) {
  const ext = LOGO[mime];
  if (!ext) throw new Error("the company picture must be a PNG, JPEG or WebP image");
  if (bytes.length === 0 || bytes.length > 1024 * 1024) throw new Error("the company picture must be under 1 MB");
  return store(bytes, ext);
}

/** Platform-generated agreement or notice, already rendered to PDF. */
export const putGenerated = (pdf: Uint8Array) => store(Buffer.from(pdf), "pdf");

export async function readDocument(ref: string) {
  if (!REF.test(ref)) throw new Error("invalid document reference");
  const contentType = MIME[ref.split(".")[1]];
  if (useBlob()) {
    const r = await get(`vault/${ref}`, { access: "private" });
    if (!r || r.statusCode !== 200) throw new Error("document not found");
    return { bytes: Buffer.from(await new Response(r.stream).arrayBuffer()), contentType };
  }
  return { bytes: await readFile(join(dir(), ref)), contentType };
}
