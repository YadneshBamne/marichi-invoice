import { getMe } from "@/server/me";
import { readDocument } from "@/server/vault";

// The signed-in person's own company picture. The ?v= in the URL changes when the picture changes, so it can be cached hard.
export async function GET() {
  const me = await getMe();
  const ref = me?.biz?.logoRef;
  if (!me || !ref) return new Response("not found", { status: 404 });
  try {
    const { bytes, contentType } = await readDocument(ref);
    return new Response(new Uint8Array(bytes), {
      headers: { "content-type": contentType, "x-content-type-options": "nosniff", "cache-control": "private, max-age=31536000, immutable" },
    });
  } catch {
    return new Response("not found", { status: 404 });
  }
}
