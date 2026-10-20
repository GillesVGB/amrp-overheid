import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import defaults from "./discord-config.json" with { type: "json" };

export function configFromEnv(env = process.env) {
  const production = env.NODE_ENV === "production";
  const rawOrigin = String(env.APP_ORIGIN || "http://127.0.0.1:4400").trim();
  let parsed;
  try {
    parsed = new URL(rawOrigin);
  } catch {
    throw Error("APP_ORIGIN moet één origin zonder pad zijn.");
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  )
    throw Error("APP_ORIGIN moet één origin zonder pad zijn.");
  const origin = parsed.origin;
  if (production && parsed.protocol !== "https:")
    throw Error("Productie vereist een HTTPS APP_ORIGIN.");
  const dataDir = path.resolve(env.DATA_DIR || "data");
  fs.mkdirSync(dataDir, { recursive: true });
  let key = env.TOKEN_ENCRYPTION_KEY;
  if (!key && !production) {
    const keyPath = path.join(dataDir, "development.key");
    if (!fs.existsSync(keyPath))
      fs.writeFileSync(keyPath, randomBytes(32).toString("base64"), {
        mode: 0o600,
      });
    key = fs.readFileSync(keyPath, "utf8");
  }
  if (Buffer.from(key || "", "base64").length !== 32)
    throw Error(
      "TOKEN_ENCRYPTION_KEY moet een base64-gecodeerde sleutel van 32 bytes zijn.",
    );
  const roles = {};
  for (const [name, envKey] of Object.entries({
    owner: "ROLE_OWNER",
    admin: "ROLE_ADMIN",
    police: "ROLE_POLICE",
    command: "ROLE_COMMAND",
    ambulance: "ROLE_AMBULANCE",
  })) {
    roles[name] =
      env[envKey] === undefined
        ? defaults[name]
        : env[envKey]
            .split(",")
            .map((x) => x.trim())
            .filter(Boolean);
    if (roles[name].some((x) => !/^\d{17,20}$/.test(x)))
      throw Error("Ongeldig Discord-rol-ID in " + envKey);
  }
  if (roles.command.some((x) => roles.police.includes(x)))
    throw Error("Agent en Korpsleiding mogen niet hetzelfde rol-ID gebruiken.");
  const config = {
    production,
    origin,
    dataDir,
    key: Buffer.from(key, "base64"),
    port: Number(env.PORT || 4400),
    host: env.HOST || "127.0.0.1",
    clientId: env.DISCORD_CLIENT_ID || "",
    clientSecret: env.DISCORD_CLIENT_SECRET || "",
    botToken: env.DISCORD_BOT_TOKEN || "",
    guildId: env.DISCORD_GUILD_ID || defaults.guildId,
    roles,
  };
  config.discordReady = Boolean(
    config.clientId &&
    config.clientSecret &&
    config.guildId &&
    (roles.admin.length || roles.owner.length),
  );
  if (production && !config.discordReady)
    throw Error("Vul eerst de Discord OAuth-configuratie en beheerrol in.");
  return config;
}
