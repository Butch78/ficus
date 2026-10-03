import { Link, Text } from "@cloudflare/kumo";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata = { title: "Ficus", description: "A git platform for agents, on Cloudflare" };

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-kumo-canvas text-kumo-default">
        {/* Kumo's floating layers (popovers, dialogs) need one stacking context at the root. */}
        <div className="isolate mx-auto flex min-h-screen max-w-5xl flex-col gap-6 px-6 py-6">
          <header className="flex items-center justify-between border-b border-kumo-hairline pb-4">
            <Link href="/" variant="plain">
              <Text variant="heading" as="h1" size="lg">
                ficus 🌿
              </Text>
            </Link>
            <Link href="https://github.com/Butch78/ficus" variant="current">
              <Text variant="secondary" as="span">
                source
              </Text>
            </Link>
          </header>
          <main className="flex flex-col gap-6">{children}</main>
        </div>
      </body>
    </html>
  );
}
