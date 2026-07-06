import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Counterdle",
  description: "The adversarial word game that counters your every move.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
