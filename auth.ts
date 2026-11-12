import "./scripts/load-config.mjs";
import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import { createHash } from "node:crypto";
import { db } from "./lib/db";
import { users } from "./lib/schema";
export const ownerId = (email: string) =>
  createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [Google],
  session: { strategy: "jwt" },
  cookies: {
    sessionToken: {
      name: "aj-notes.session-token",
      options: {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure: process.env.NODE_ENV === "production",
      },
    },
  },
  callbacks: {
    async signIn({ profile, user }) {
      const email = user.email?.trim().toLowerCase();
      if (
        !email ||
        profile?.email_verified !== true ||
        email !== process.env.ALLOWED_EMAIL?.trim().toLowerCase()
      )
        return false;
      await db()
        .insert(users)
        .values({ id: ownerId(email), email })
        .onConflictDoUpdate({ target: users.id, set: { email } });
      return true;
    },
  },
});
