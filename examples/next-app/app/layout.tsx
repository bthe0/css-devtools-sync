import type { Metadata } from "next";
import "./globals.css";

// NOTE: no `next/font` here. dev-sync needs a `.babelrc` (for the source-locator
// JSX stamping), which forces Next onto Babel — and `next/font` requires SWC, so
// the two are mutually exclusive (babel-font-loader-conflict). The font stack is
// set in globals.css instead.

export const metadata: Metadata = {
  title: "dev-sync — Next.js example",
  description: "Edit CSS in DevTools, watch it write back to source.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased">
      {/*
        suppressHydrationWarning: browser extensions (Grammarly, password
        managers, etc.) inject attributes onto <body> — e.g. data-gr-ext-installed,
        data-new-gr-c-s-check-loaded — before React hydrates, which otherwise
        throws a hydration attribute-mismatch error. This suppresses the warning
        for <body>'s OWN attributes only (not its children), which is exactly the
        surface extensions mutate. It does not mask real markup bugs inside the tree.
      */}
      <body className="min-h-full flex flex-col" suppressHydrationWarning>
        {children}
      </body>
    </html>
  );
}
