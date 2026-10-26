import test from "node:test";
import assert from "node:assert/strict";
import {
  createCreatorProfile,
  creatorAvatar,
  CREATOR_ID,
} from "../server/creator-profile.mjs";

test("Profielwijzigingen gebruiken de nieuwe avatarhash; privéstatus en activiteiten worden niet doorgegeven", async () => {
  let time = 0,
    calls = 0;
  const profile = createCreatorProfile({
    clock: () => time,
    request: async () => {
      calls++;
      return Response.json({
        success: true,
        data: {
          discord_user: {
            id: CREATOR_ID,
            avatar:
              calls === 1
                ? "a_0123456789abcdef0123456789abcdef"
                : "abcdef0123456789abcdef0123456789",
          },
          activities: ["PRIVATE"],
          discord_status: "online",
        },
      });
    },
  });
  const initial = await Promise.all([profile(), profile()]);
  assert.equal(calls, 1);
  assert.deepEqual(initial[0], initial[1]);
  assert.ok(initial[0].avatarUrl.includes(".gif?size=64"));
  time = 60001;
  const updated = await profile();
  assert.equal(calls, 2);
  assert.ok(
    updated.avatarUrl.includes("/abcdef0123456789abcdef0123456789.png"),
  );
  assert.deepEqual(Object.keys(updated).sort(), ["avatarUrl", "discordId"]);
});
test("Verwijderde avatar, verkeerde identiteit en externe payloads blijven veilig", () => {
  assert.match(
    creatorAvatar({ id: CREATOR_ID, avatar: null, discriminator: "0" }),
    /^https:\/\/cdn\.discordapp\.com\/embed\/avatars\/\d\.png$/,
  );
  assert.equal(
    creatorAvatar({
      id: CREATOR_ID,
      avatar: "https://untrusted.example/picture",
    }),
    null,
  );
  assert.equal(
    creatorAvatar({ id: "wrong", avatar: "0123456789abcdef0123456789abcdef" }),
    null,
  );
});
test("Bij een Lanyard-storing blijven de footer en de laatst bekende avatar beschikbaar", async () => {
  let time = 0;
  const profile = createCreatorProfile({
    clock: () => time,
    request: async () => {
      if (time) throw Error("Unavailable");
      return Response.json({
        success: true,
        data: {
          discord_user: {
            id: CREATOR_ID,
            avatar: "0123456789abcdef0123456789abcdef",
          },
        },
      });
    },
  });
  const initial = await profile();
  time = 60001;
  assert.deepEqual(await profile(), initial);
});
