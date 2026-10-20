import { handleVercelRequest } from "../../server/vercel-runtime.mjs";

export default function handler(req, res) {
  return handleVercelRequest(req, res, { authRoute: true });
}
