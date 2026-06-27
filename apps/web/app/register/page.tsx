import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { RegisterForm } from "@/components/auth/RegisterForm";

export default async function RegisterPage() {
  const session = await getServerSession();
  if (session) {
    redirect("/dashboard");
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-8 bg-background">
      <div className="card w-full max-w-md">
        <h2 className="text-lg font-semibold text-text-primary mb-6">Create Account</h2>
        <RegisterForm />
      </div>
    </div>
  );
}
