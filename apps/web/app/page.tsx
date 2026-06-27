import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";

export default async function IndexPage() {
  const session = await getServerSession();
  if (session) {
    redirect("/dashboard");
  } else {
    redirect("/login");
  }
}

