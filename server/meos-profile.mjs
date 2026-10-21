import { createHash, timingSafeEqual } from "node:crypto";

// MEOS may read only the current callsign for one Discord identity.
// This token grants no login, administration or database-write access.
export function installMeosProfile(app, { db, config }) {
  app.get("/api/integrations/meos/profile/:discordId", (req, res) => {
    res.set("Cache-Control", "no-store");
    const secret = String(config.meosProfileSecret || "");
    if (secret.length < 32)
      return res
        .status(503)
        .json({ ok: false, error: "Koppeling niet ingesteld." });
    const header = req.get("authorization") || "";
    const supplied = header.startsWith("Bearer ") ? header.slice(7) : "";
    const digest = (value) => createHash("sha256").update(value).digest();
    if (!supplied || !timingSafeEqual(digest(supplied), digest(secret))) {
      return res.status(401).json({ ok: false, error: "Geen toegang." });
    }
    const discordId = req.params.discordId;
    if (!/^\d{17,20}$/.test(discordId))
      return res.status(400).json({ ok: false, error: "Ongeldig Discord-ID." });
    const person = db
      .prepare(
        `
      SELECT c.number callsign FROM personnel p
      LEFT JOIN callsigns c ON c.personnel_id=p.id
      WHERE p.discord_id=? AND p.active=1
    `,
      )
      .get(discordId);
    if (!person)
      return res
        .status(404)
        .json({ ok: false, error: "Geen actieve medewerker gevonden." });
    return res.json({
      ok: true,
      profile: { discordId, callsign: person.callsign || "" },
    });
  });
}
