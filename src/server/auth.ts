import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { twoFactor } from "better-auth/plugins";
import { db, type Database } from "./db/client";
import * as schema from "./db/schema";
import { gateway } from "./integrations/gateway";

export const makeAuth = (d: Database) =>
  betterAuth({
    appName: "Marichi Labs",
    database: drizzleAdapter(d, { provider: "pg", schema: { ...schema, user: schema.users } }),
    advanced: { database: { generateId: "uuid" } },
    // CSRF origin check: the browser's origin must match BETTER_AUTH_URL. In development Next may pick 3000/3001/3002
    // depending on what's free, so trust the usual local ports. Production trusts only BETTER_AUTH_URL.
    trustedOrigins: process.env.NODE_ENV === "production" ? [] : [3000, 3001, 3002, 3003].flatMap((p) => [`http://localhost:${p}`, `http://127.0.0.1:${p}`]),
    // Session cookie cache: most requests validate the session from the signed cookie instead of a database round trip.
    // The short window bounds how long a role change or sign-out takes to show; suspension is re-checked against the database.
    session: { cookieCache: { enabled: true, maxAge: 60 } },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 10,
      resetPasswordTokenExpiresIn: 3600,
      // Not awaited: response time must not reveal whether the address has an account.
      sendResetPassword: async ({ user, url }) => {
        if (process.env.NODE_ENV !== "production") console.log(`[dev] password reset link for ${user.email}: ${url}`);
        void gateway.notify.send({
          channel: "email", to: user.email, template: "password_reset", data: {},
          subject: "Reset your Marichi password",
          body: `Hello ${user.name},

Use this link to set a new password. It expires in 1 hour.

${url}

If you didn't ask for this, you can ignore this email. Your password won't change.`,
        }).catch(() => { /* the user can simply request another link */ });
      },
    },
    // role/businessId are server-controlled: clients can never set them (privilege escalation).
    user: {
      additionalFields: {
        role: { type: "string", input: false, defaultValue: "seller" },
        businessId: { type: "string", input: false, required: false },
      },
    },
    plugins: [twoFactor({ issuer: "Marichi Labs" }), nextCookies()],
  });

export const auth = makeAuth(db);
