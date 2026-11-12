import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "AJ Notes",
  description: "A private home for your ideas.",
  manifest: "/manifest.webmanifest",
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
