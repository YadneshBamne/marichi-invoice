import Link from "next/link";
import { AuthLayout } from "@/components/ui/public";
import { SignupWizard } from "./wizard";

export const metadata = { title: "Create account" };

export default function SignUp() {
  return (
    <AuthLayout wide title="Create your account" sub="It takes about two minutes. You will verify your business afterwards."
      footer={<>Already have an account? <Link className="font-semibold text-p-700 hover:underline" href="/login">Log in</Link></>}>
      <SignupWizard />
    </AuthLayout>
  );
}
