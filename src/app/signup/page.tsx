import Link from "next/link";
import { AuthLayout } from "@/components/ui/public";
import { SignupWizard } from "./wizard";

export const metadata = { title: "Create account" };

export default async function SignUp({ searchParams }: { searchParams: Promise<{ as?: string }> }) {
  const as = (await searchParams).as;
  const initialRole = as === "seller" || as === "buyer" || as === "financier" ? as : undefined;
  return (
    <AuthLayout wide title="Create your account" sub="It takes about two minutes. You will verify your business afterwards."
      footer={<>Already have an account? <Link className="font-semibold text-p-700 hover:underline" href="/login">Log in</Link></>}>
      <SignupWizard initialRole={initialRole} />
    </AuthLayout>
  );
}
