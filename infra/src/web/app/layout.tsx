import type { ReactNode } from "react";
import "./globals.css";

export const metadata = { title: "Ficus", description: "A git platform for agents, on Cloudflare" };

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header>
          <h1>
            <a href="/">ficus 🌿</a>
          </h1>
          <a className="muted" href="https://github.com/Butch78/ficus">
            source
          </a>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
