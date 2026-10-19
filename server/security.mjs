import {
  randomBytes,
  createHash,
  scrypt,
  timingSafeEqual,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
import { promisify } from "node:util";
const derive = promisify(scrypt);
export const token = () => randomBytes(32).toString("base64url");
export const digest = (value) =>
  createHash("sha256").update(value).digest("hex");
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
export function requireValue(condition, status, message) {
  if (!condition) throw new HttpError(status, message);
}
export function text(value, label, max = 120, optional = false) {
  requireValue(typeof value === "string", 400, label + " ontbreekt.");
  const result = value.trim();
  requireValue(
    (optional || result.length > 0) &&
      result.length <= max &&
      !/[\u0000-\u0008\u000b-\u001f\u007f]/.test(result),
    400,
    label + " is ongeldig.",
  );
  return result;
}
export function snowflake(value, label = "Discord-ID") {
  const v = text(value, label, 20);
  requireValue(
    /^\d{17,20}$/.test(v),
    400,
    label + " moet een Discord-ID zijn.",
  );
  return v;
}
export function positive(value, label, max = 500) {
  const n = Number(value);
  requireValue(
    Number.isInteger(n) && n >= 0 && n <= max,
    400,
    label + " is ongeldig.",
  );
  return n;
}
export function passwordValid(value) {
  requireValue(
    typeof value === "string" && value.length >= 12 && value.length <= 128,
    400,
    "Gebruik een wachtwoord van 12 tot 128 tekens.",
  );
  return value;
}
export async function hashPassword(value) {
  passwordValid(value);
  const salt = randomBytes(16).toString("hex");
  const key = await derive(value, salt, 64, {
    N: 32768,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
  return `scrypt$32768$${salt}$${key.toString("hex")}`;
}
const dummy =
  "scrypt$32768$00000000000000000000000000000000$" + "0".repeat(128);
export async function verifyPassword(value, encoded) {
  const [, cost, salt, hash] = (encoded || dummy).split("$");
  if (typeof value !== "string" || value.length > 128) return false;
  const key = await derive(value, salt, 64, {
    N: Number(cost),
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
  return timingSafeEqual(key, Buffer.from(hash, "hex")) && Boolean(encoded);
}
export function encrypt(value, key) {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key, iv);
  return Buffer.concat([
    iv,
    cipher.update(JSON.stringify(value)),
    cipher.final(),
    cipher.getAuthTag(),
  ]).toString("base64");
}
export function decrypt(value, key) {
  const b = Buffer.from(value, "base64"),
    cipher = createDecipheriv("aes-256-gcm", key, b.subarray(0, 12));
  cipher.setAuthTag(b.subarray(-16));
  return JSON.parse(
    Buffer.concat([
      cipher.update(b.subarray(12, -16)),
      cipher.final(),
    ]).toString("utf8"),
  );
}
export function cookieMap(req) {
  return Object.fromEntries(
    (req.headers.cookie || "")
      .split(";")
      .map((x) => x.trim().split("="))
      .filter((x) => x.length === 2),
  );
}
export function permissions(roles, settings, ownerRoles = []) {
  const has = (name) =>
    (settings.roles[name] || []).some((id) => roles.includes(id));
  const owner = ownerRoles.some((id) => roles.includes(id)),
    admin = owner || has("admin"),
    command = admin || has("command");
  const extra = (name) =>
    (settings.grants?.[name] || []).some((id) => roles.includes(id));
  return {
    owner,
    admin,
    policeRead:
      command || has("police") || extra("policeRead") || extra("policeWrite"),
    policeWrite: command || extra("policeWrite"),
    archive: command || extra("archive"),
    audit: command || extra("audit"),
    accounts: admin,
    settings: admin,
    ranks: command,
    ambulance:
      owner ||
      Boolean(settings.ambulanceEnabled && (admin || has("ambulance"))),
  };
}
export function detectFile(buffer) {
  if (
    buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return { mime: "image/png", ext: ".png" };
  if (buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255)
    return { mime: "image/jpeg", ext: ".jpg" };
  if (["GIF87a", "GIF89a"].includes(buffer.subarray(0, 6).toString()))
    return { mime: "image/gif", ext: ".gif" };
  if (
    buffer.subarray(0, 4).toString() === "RIFF" &&
    buffer.subarray(8, 12).toString() === "WEBP"
  )
    return { mime: "image/webp", ext: ".webp" };
  if (buffer.subarray(0, 5).toString() === "%PDF-")
    return { mime: "application/pdf", ext: ".pdf" };
  const value = buffer.toString("utf8");
  if (
    !value.includes("\ufffd") &&
    !/[\x00-\x08\x0b-\x1f]/.test(value) &&
    !/<\s*(?:!doctype|html|svg|script|iframe)/i.test(value)
  )
    return { mime: "text/plain; charset=utf-8", ext: ".txt" };
  throw new HttpError(
    400,
    "Dit bestandstype is niet toegestaan. Kies PNG, JPG, GIF, WebP, PDF of platte tekst.",
  );
}
