import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "myorl migration",
  description: "MODX → Strapi v5 + Next.js (dev)",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
