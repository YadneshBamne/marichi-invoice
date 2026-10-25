import type { Metadata } from "next";
import { cookies } from "next/headers";
import { Plus_Jakarta_Sans } from "next/font/google";
import "./globals.css";

const sans = Plus_Jakarta_Sans({ variable: "--font-sans-brand", subsets: ["latin"], weight: ["400", "500", "600", "700"], display: "swap" });

export const metadata: Metadata = {
  title: { default: "Marichi Labs", template: "%s | Marichi Labs" },
  description: "Invoice financing for MSMEs: turn unpaid invoices into working capital.",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  // An explicit choice is saved in a cookie so the server can render it: no script, no flash. With no cookie the page follows the device.
  const choice = (await cookies()).get("marichi-theme")?.value;
  const theme = choice === "light" || choice === "dark" ? choice : undefined;
  return (
    <html lang="en" className={`${sans.variable} h-full`} data-theme={theme}>
      <body className="min-h-full">{children}</body>
    </html>
  );
}
