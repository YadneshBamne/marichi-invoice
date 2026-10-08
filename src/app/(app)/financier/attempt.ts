import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

/** Run a financier action; a business-rule error comes back to the page as a message instead of an error screen. */
export async function attempt(path: string, fn: () => Promise<string | void>) {
  let msg: string | void;
  try { msg = await fn(); } catch (e) {
    redirect(`${path}?error=${encodeURIComponent(e instanceof Error ? e.message : "Something went wrong")}`);
  }
  revalidatePath(path);
  redirect(msg ? `${path}?ok=${encodeURIComponent(msg)}` : path);
}
