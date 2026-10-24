import { auth } from "../auth";

/** Hash a password exactly the way Better Auth does, so a password an invited person chooses works at the normal login screen. */
export const hashPassword = async (password: string) => (await auth.$context).password.hash(password);
