import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const ALLOWED: Record<string, string> = { "application/pdf": "pdf", "image/png": "png", "image/jpeg": "jpg" };
const MIME: Record<string, string> = { pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", webp: "image/webp", html: "text/html; charset=utf-8" };
const LOGO: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" }; // never SVG: it can carry script
const MAX_BYTES = 5 * 1024 * 1024;
const REF = /^[a-f0-9]{64}\.(pdf|png|jpg|webp|html)$/; // the only shape that ever touches the filesystem path
const dir = () => join(process.cwd(), ".data", "vault");

/**
 * Document vault. Content-addressed, so the same bytes always give the same ref and hash.
 * ponytail: local disk. Swap these functions for S3 (SSE + versioning) before production.
 */
async function store(bytes: Buffer, ext: string) {
  const hash = createHash("sha256").update(bytes).digest("hex");
  await mkdir(dir(), { recursive: true });
  const ref = `${hash}.${ext}`;
  await writeFile(join(dir(), ref), bytes);
  return { ref, hash };
}

/** User-uploaded invoice file. */
export async function putDocument(bytes: Buffer, mime: string) {
  const ext = ALLOWED[mime];
  if (!ext) throw new Error("only PDF, PNG or JPEG files are accepted");
  if (bytes.length === 0 || bytes.length > MAX_BYTES) throw new Error("file must be between 1 byte and 5 MB");
  return store(bytes, ext);
}

/** Company picture. Small raster images only. */
export async function putLogo(bytes: Buffer, mime: string) {
  const ext = LOGO[mime];
  if (!ext) throw new Error("the company picture must be a PNG, JPEG or WebP image");
  if (bytes.length === 0 || bytes.length > 1024 * 1024) throw new Error("the company picture must be under 1 MB");
  return store(bytes, ext);
}

/** Platform-generated agreement/notice (HTML for now; PDF rendering is a later swap behind this function). */
export const putGenerated = (html: string) => store(Buffer.from(html, "utf8"), "html");

export async function readDocument(ref: string) {
  if (!REF.test(ref)) throw new Error("invalid document reference");
  return { bytes: await readFile(join(dir(), ref)), contentType: MIME[ref.split(".")[1]] };
}
