"use server"

import { signIn } from "@/lib/auth"
import { AuthError } from "next-auth"

export async function login(
  _prevState: { error?: string } | null,
  formData: FormData
): Promise<{ error?: string }> {
  try {
    await signIn("credentials", {
      email: formData.get("email"),
      password: formData.get("password"),
      redirectTo: "/dashboard",
    })
    return {}
  } catch (error) {
    if (error instanceof AuthError) {
      switch (error.type) {
        case "CredentialsSignin":
          return { error: "Invalid email or password." }
        default:
          return { error: "Something went wrong. Please try again." }
      }
    }
    // NEXT_REDIRECT must be re-thrown
    throw error
  }
}
