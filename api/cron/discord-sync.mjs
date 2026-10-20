import { timingSafeEqual } from "node:crypto";
import { runDiscordSync } from "../../server/vercel-runtime.mjs";

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET || "";
  const authorization = req.headers.authorization || "";
  const expected = Buffer.from(`Bearer ${secret}`);
  const supplied = Buffer.from(authorization);
  if (
    !secret ||
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected)
  ) {
    res.status(401).json({ error: "Niet geautoriseerd." });
    return;
  }
  try {
    res.status(200).json(await runDiscordSync());
  } catch (error) {
    console.error("Geplande Discord-synchronisatie mislukt:", error?.name);
    res.status(500).json({ error: "Discord-synchronisatie mislukt." });
  }
}
