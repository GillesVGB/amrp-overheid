import { withVercelErrorBoundary } from "../server/vercel-errors.mjs";

export default function handler(req, res) {
  return withVercelErrorBoundary(req, res, async () => {
    const { handleVercelRequest } =
      await import("../server/vercel-runtime.mjs");
    return handleVercelRequest(req, res);
  });
}
