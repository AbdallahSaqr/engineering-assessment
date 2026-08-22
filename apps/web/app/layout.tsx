import "@fontsource-variable/ibm-plex-sans";
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import "./styles.css";

export const metadata: Metadata = {
  title: "Mizan — Loan application",
  description: "Track a loan application and its status history.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="site-header">
          <Link className="brand" href="/">
            Mizan
          </Link>
          <span>Customer portal</span>
        </header>
        {children}
      </body>
    </html>
  );
}
