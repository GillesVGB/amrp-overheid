export const CREATOR_ID = "960090714950225970";

export function creatorAvatar(user) {
  if (user?.id !== CREATOR_ID) return null;
  if (user.avatar === null) {
    const index =
      user.discriminator && user.discriminator !== "0"
        ? Number(user.discriminator) % 5
        : Number((BigInt(CREATOR_ID) >> 22n) % 6n);
    return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
  }
  if (!/^(?:a_)?[a-f0-9]{16,64}$/.test(user.avatar || "")) return null;
  return `https://cdn.discordapp.com/avatars/${CREATOR_ID}/${user.avatar}.${user.avatar.startsWith("a_") ? "gif" : "png"}?size=64`;
}

export function createCreatorProfile({
  request = fetch,
  clock = Date.now,
} = {}) {
  let cached = { discordId: CREATOR_ID, avatarUrl: null },
    expires = 0,
    pending;
  return async function profile() {
    if (expires > clock()) return cached;
    if (pending) return pending;
    pending = Promise.resolve().then(async () => {
      try {
        const response = await request(
          `https://api.lanyard.rest/v1/users/${CREATOR_ID}`,
          {
            signal: AbortSignal.timeout(5000),
            cache: "no-store",
            redirect: "error",
          },
        );
        if (response.ok) {
          const payload = await response.json();
          const avatarUrl =
            payload.success === true
              ? creatorAvatar(payload.data?.discord_user)
              : null;
          if (avatarUrl) cached = { discordId: CREATOR_ID, avatarUrl };
        }
      } catch {
        /* The credit and the site keep working during a Lanyard outage. */
      } finally {
        expires = clock() + 15000;
        pending = null;
      }
      return cached;
    });
    return pending;
  };
}
