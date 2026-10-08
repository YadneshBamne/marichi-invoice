import { auth } from "../auth";

/** Hash a password exactly the way Better Auth does, so owner-issued credentials work at the normal login screen. */
export const hashPassword = async (password: string) => (await auth.$context).password.hash(password);
