import type { Metadata } from "next";
import "./globals.css";
import Script from "next/script";

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
      <Script data-goatcounter="https://chartung.goatcounter.com/count" async src="//gc.zgo.at/count.js"></Script>
      <body>{children}</body>
    </html>
  );
}
