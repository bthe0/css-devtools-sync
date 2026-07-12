import type { NextConfig } from "next";
import { withDevSync } from "@dev-sync/webpack";

const nextConfig: NextConfig = {
  /* your config here */
};

// Enables css-devtools-sync on the webpack dev server (`next dev --webpack`).
export default withDevSync(nextConfig);
