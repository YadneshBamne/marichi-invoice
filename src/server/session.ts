import { cache } from "react";
import { headers } from "next/headers";
import { auth } from "./auth";

/** One session lookup per request, shared by the layout, the page and its server actions. */
export const getSession = cache(async () => auth.api.getSession({ headers: await headers() }));
