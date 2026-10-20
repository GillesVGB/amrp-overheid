import {
  token,
  digest,
  encrypt,
  decrypt,
  cookieMap,
  permissions,
  applyAccountAccess,
  HttpError,
  requireValue,
  verifyPassword,
  hashPassword,
  text,
} from "./security.mjs";
import {
  getSettings,
  getAccountAccess,
  publicUser,
  audit,
  id,
  timestamp,
  transaction,
} from "./database.mjs";
const API = "https://discord.com/api/v10";
import { completeDiscordLogin } from "./discord-login.mjs";
export function authentication({
  db,
  config,
  discord,
  clock = Date.now,
  request = fetch,
}) {
  const cookies = {
    httpOnly: true,
    secure: config.production,
    sameSite: "lax",
    path: "/",
  };
  const sessionName = config.production ? "__Host-gov-session" : "gov-session";
  const flowName = config.production ? "__Host-gov-flow" : "gov-flow";
  const verifiedMembers = new Map();
  const pendingMembers = new Map();
  const refreshedTokens = new Map();
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const clear = (res) => {
    res.clearCookie(sessionName, cookies);
    res.clearCookie(flowName, cookies);
  };
  function limit(key, max = 10, window = 15 * 60e3) {
    const now = clock(),
      row = db.prepare("SELECT * FROM rate_limits WHERE key=?").get(key);
    if (!row || row.expires_at <= now)
      db.prepare("INSERT OR REPLACE INTO rate_limits VALUES(?,?,?)").run(
        key,
        1,
        now + window,
      );
    else {
      if (row.count >= max) {
        const seconds = Math.max(1, Math.ceil((row.expires_at - now) / 1000));
        const error = new HttpError(
          429,
          `Te veel mislukte pogingen. Probeer het over ${seconds} seconden opnieuw.`,
        );
        error.retryAfter = seconds;
        throw error;
      }
      db.prepare("UPDATE rate_limits SET count=count+1 WHERE key=?").run(key);
    }
  }
  async function api(endpoint, accessToken) {
    let response;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        response = await request(API + endpoint, {
          headers: { Authorization: "Bearer " + accessToken },
          signal: AbortSignal.timeout(8000),
        });
      } catch (error) {
        if (attempt === 0) {
          await wait(250);
          continue;
        }
        console.warn(
          "Discord API-controle mislukt:",
          error.code || error.name || "onbekend",
        );
        throw new HttpError(
          503,
          "Discord kan je rechten nu niet controleren. Probeer later opnieuw.",
        );
      }
      if (response.ok || [401, 403, 404].includes(response.status)) break;
      if (attempt > 0 || (response.status !== 429 && response.status < 500))
        break;
      const retryAfter = Number(response.headers.get("retry-after"));
      const delay =
        response.status === 429 && Number.isFinite(retryAfter)
          ? retryAfter * 1000
          : 250;
      if (delay > 2000) break;
      await wait(Math.max(100, delay));
    }
    if (response.status === 401)
      throw new HttpError(
        401,
        "Je Discord-koppeling is verlopen. Meld opnieuw aan.",
      );
    if (response.status === 404 || response.status === 403)
      throw new HttpError(403, "Je bent geen lid van de overheids-Discord.");
    requireValue(
      response.ok,
      503,
      "Discord kan je rechten nu niet controleren. Probeer later opnieuw.",
    );
    return response.json();
  }
  async function exchange(params) {
    const response = await request(API + "/oauth2/token", {
      method: "POST",
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        ...params,
      }),
      signal: AbortSignal.timeout(8000),
    });
    requireValue(
      response.ok,
      401,
      "Discord-koppeling is verlopen. Meld opnieuw aan.",
    );
    return response.json();
  }
  async function member(tokens, persistTokens = null) {
    if (discord) return discord.member(tokens);
    if (tokens.expiresAt <= clock() + 30000) {
      const refreshKey = digest(tokens.refreshToken);
      let refresh = refreshedTokens.get(refreshKey);
      if (!refresh || refresh.expiresAt <= clock()) {
        refresh = {
          expiresAt: clock() + 30000,
          promise: exchange({
            grant_type: "refresh_token",
            refresh_token: tokens.refreshToken,
          }).then((value) => ({
            accessToken: value.access_token,
            refreshToken: value.refresh_token,
            expiresAt: clock() + value.expires_in * 1000,
          })),
        };
        refreshedTokens.set(refreshKey, refresh);
      }
      try {
        tokens = await refresh.promise;
        // Discord rotates refresh tokens. Save them before the membership request:
        // a temporary Discord outage must not discard a successful refresh.
        persistTokens?.(tokens);
      } catch (error) {
        if (refreshedTokens.get(refreshKey) === refresh)
          refreshedTokens.delete(refreshKey);
        throw error;
      }
      for (const [oldKey, entry] of refreshedTokens)
        if (entry.expiresAt <= clock()) refreshedTokens.delete(oldKey);
      if (refreshedTokens.size > 512)
        refreshedTokens.delete(refreshedTokens.keys().next().value);
    }
    const key = digest(tokens.accessToken);
    // This short verification travels in the encrypted server-side session. It
    // works across serverless instances, while keeping the same 30-second bound.
    const sessionCheck = tokens.verification;
    if (
      sessionCheck?.key === key &&
      sessionCheck.guildId === config.guildId &&
      sessionCheck.expiresAt > clock() &&
      sessionCheck.expiresAt <= clock() + 30000 &&
      Array.isArray(sessionCheck.value?.roles) &&
      sessionCheck.value?.identity?.id
    )
      return { ...sessionCheck.value, tokens };
    const cached = verifiedMembers.get(key);
    if (cached && cached.expiresAt > clock()) {
      tokens = {
        ...tokens,
        verification: { ...cached, key, guildId: config.guildId },
      };
      return { ...cached.value, tokens };
    }
    verifiedMembers.delete(key);
    let check = pendingMembers.get(key);
    if (!check) {
      check = (async () => {
        const identity = await api("/users/@me", tokens.accessToken);
        const membership = await api(
          `/users/@me/guilds/${config.guildId}/member`,
          tokens.accessToken,
        );
        return { identity, roles: membership.roles };
      })();
      pendingMembers.set(key, check);
    }
    try {
      const value = await check;
      for (const [oldKey, entry] of verifiedMembers)
        if (entry.expiresAt <= clock()) verifiedMembers.delete(oldKey);
      if (verifiedMembers.size >= 512)
        verifiedMembers.delete(verifiedMembers.keys().next().value);
      const verification = { value, expiresAt: clock() + 30_000 };
      verifiedMembers.set(key, verification);
      tokens = {
        ...tokens,
        verification: { ...verification, key, guildId: config.guildId },
      };
      return { ...value, tokens };
    } finally {
      if (pendingMembers.get(key) === check) pendingMembers.delete(key);
    }
  }
  function createSession(res, user, tokens) {
    const raw = token(),
      csrf = token();
    db.prepare("INSERT INTO sessions VALUES(?,?,?,?,?,?)").run(
      digest(raw),
      user.id,
      csrf,
      encrypt(tokens, config.key),
      clock() + 8 * 3600e3,
      clock(),
    );
    res.cookie(sessionName, raw, { ...cookies, maxAge: 8 * 3600e3 });
    return csrf;
  }
  async function auth(req, res, next) {
    try {
      const raw = cookieMap(req)[sessionName] || "",
        hash = digest(raw),
        session = db.prepare("SELECT * FROM sessions WHERE hash=?").get(hash);
      requireValue(
        session &&
          session.expires_at > clock() &&
          session.last_seen > clock() - 30 * 60e3,
        401,
        "Meld je aan om verder te gaan.",
      );
      const user = db
        .prepare("SELECT * FROM users WHERE id=?")
        .get(session.user_id);
      requireValue(user?.enabled, 401, "Dit account is uitgeschakeld.");
      let verified;
      try {
        verified = await member(
          decrypt(session.tokens, config.key),
          (tokens) => {
            db.prepare("UPDATE sessions SET tokens=? WHERE hash=?").run(
              encrypt(tokens, config.key),
              hash,
            );
          },
        );
      } catch (error) {
        if ([401, 403].includes(error.status))
          db.prepare("DELETE FROM sessions WHERE hash=?").run(hash);
        throw error;
      }
      requireValue(
        verified.identity.id === user.discord_id,
        403,
        "De Discord-identiteit komt niet overeen.",
      );
      const settings = getSettings(db),
        grants = applyAccountAccess(
          permissions(verified.roles, settings, config.roles.owner || []),
          getAccountAccess(db, user.id),
          settings,
        );
      requireValue(
        Object.values(grants).some(Boolean),
        403,
        "Je hebt geen toegangsrol voor deze omgeving.",
      );
      db.prepare("UPDATE sessions SET last_seen=?,tokens=? WHERE hash=?").run(
        clock(),
        encrypt(verified.tokens, config.key),
        hash,
      );
      req.auth = {
        user,
        session,
        grants,
        roles: verified.roles,
        identity: verified.identity,
        hash,
      };
      next();
    } catch (error) {
      next(error);
    }
  }
  const csrf = (req, res, next) => {
    try {
      requireValue(
        req.get("origin") === config.origin,
        403,
        "Ongeldige herkomst van het verzoek.",
      );
      requireValue(
        req.get("x-csrf-token") === req.auth.session.csrf,
        403,
        "Beveiligingscontrole verlopen. Vernieuw de pagina.",
      );
      next();
    } catch (e) {
      next(e);
    }
  };
  const permit = (name) => (req, res, next) => {
    try {
      requireValue(
        !req.auth.user.must_change,
        403,
        "Wijzig eerst je tijdelijke wachtwoord.",
      );
      requireValue(
        req.auth.grants[name],
        403,
        "Je hebt geen rechten voor deze handeling.",
      );
      next();
    } catch (e) {
      next(e);
    }
  };
  const sameOrigin = (req, res, next) => {
    try {
      requireValue(
        req.get("origin") === config.origin,
        403,
        "Ongeldige herkomst van het verzoek.",
      );
      next();
    } catch (e) {
      next(e);
    }
  };
  function install(app) {
    app.post("/auth/discord/login", sameOrigin, (req, res) => {
      requireValue(
        config.discordReady,
        503,
        "Discord-login is nog niet ingesteld.",
      );
      limit("discord-login:" + req.ip, 30, 60000);
      const state = token(),
        verifier = token();
      const old = cookieMap(req)[flowName];
      db.prepare("DELETE FROM discord_login_flows WHERE expires_at<?").run(
        clock(),
      );
      if (old)
        db.prepare("DELETE FROM discord_login_flows WHERE hash=?").run(
          digest(old),
        );
      db.prepare("INSERT INTO discord_login_flows VALUES(?,?,?)").run(
        digest(state),
        verifier,
        clock() + 5 * 60e3,
      );
      res.cookie(flowName, state, { ...cookies, maxAge: 5 * 60e3 });
      const params = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: config.origin + "/auth/discord/callback",
        response_type: "code",
        scope: "identify guilds.members.read",
        state,
        code_challenge: Buffer.from(digest(verifier), "hex").toString(
          "base64url",
        ),
        code_challenge_method: "S256",
      });
      if (req.body?.switchAccount === true) params.set("prompt", "consent");
      res.json({ oauthUrl: "https://discord.com/oauth2/authorize?" + params });
    });
    app.get("/api/health", (req, res) =>
      res.json({
        ok: true,
        discordConfigured: config.discordReady,
        demo: Boolean(config.demo),
        service: "Overheidsportaal",
      }),
    );
    app.post("/auth/login", sameOrigin, async (req, res) => {
      limit("login-requests-v2:" + req.ip, 120, 60000);
      const username = text(
        req.body.username,
        "Gebruikersnaam",
        80,
      ).toLowerCase();
      const failureKey = "login-failures-v2:" + req.ip + ":" + username;
      const user = db
        .prepare("SELECT * FROM users WHERE username=?")
        .get(username);
      const valid = await verifyPassword(
        req.body.password,
        user?.password_hash,
      );
      if (!user?.enabled || !valid) {
        limit(failureKey, 10, 60000);
        throw new HttpError(401, "Gebruikersnaam of wachtwoord is onjuist.");
      }
      // A valid password must not be locked out by earlier OAuth retries.
      db.prepare("DELETE FROM rate_limits WHERE key IN (?,?,?)").run(
        failureKey,
        "login-user:" + username,
        "login-ip:" + req.ip,
      );
      // Development identities only exist in the separately bound loopback demo server.
      if (discord && config.demo) {
        const tokens = { demoId: user.discord_id },
          verified = await member(tokens);
        requireValue(
          Object.values(
            applyAccountAccess(
              permissions(
                verified.roles,
                getSettings(db),
                config.roles.owner || [],
              ),
              getAccountAccess(db, user.id),
              getSettings(db),
            ),
          ).some(Boolean),
          403,
          "Geen toegangsrol.",
        );
        createSession(res, user, tokens);
        audit(db, user, "sessie.aangemeld", user.id);
        return res.json({ ok: true });
      }
      requireValue(
        config.discordReady,
        503,
        "Discord-login is nog niet geconfigureerd door de beheerder.",
      );
      const raw = token();
      db.prepare("INSERT INTO auth_flows VALUES(?,?,?,?)").run(
        digest(raw),
        user.id,
        "preauth",
        clock() + 5 * 60e3,
      );
      res.cookie(flowName, raw, { ...cookies, maxAge: 5 * 60e3 });
      res.json({ oauthUrl: "/auth/discord/start" });
    });
    app.post("/auth/register", sameOrigin, (req, res) => {
      limit("register-ip:" + req.ip, 8);
      requireValue(
        config.discordReady,
        503,
        "Discord-login is nog niet geconfigureerd door de beheerder.",
      );
      const username = text(
        req.body.username,
        "Gebruikersnaam",
        80,
      ).toLowerCase();
      requireValue(
        /^[\p{L}\p{N}._-]+$/u.test(username),
        400,
        "Gebruik alleen letters, cijfers, punten, streepjes en underscores.",
      );
      limit("register-user:" + username, 4);
      requireValue(
        !db.prepare("SELECT id FROM users WHERE username=?").get(username),
        409,
        "Deze gebruikersnaam is al in gebruik. Meld je aan met je bestaande account.",
      );
      requireValue(
        (config.roles.police || []).length ||
          (config.roles.ambulance || []).length ||
          (config.roles.command || []).length,
        503,
        "Zelfregistratie is nog niet ingesteld voor politie of ambulance.",
      );
      const state = token();
      db.prepare("INSERT INTO signup_flows VALUES(?,?,?)").run(
        digest(state),
        username,
        clock() + 5 * 60e3,
      );
      res.cookie(flowName, state, { ...cookies, maxAge: 5 * 60e3 });
      const params = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: config.origin + "/auth/discord/callback",
        response_type: "code",
        scope: "identify guilds.members.read",
        state,
        prompt: "consent",
      });
      res.json({
        oauthUrl: "https://discord.com/oauth2/authorize?" + params,
      });
    });
    app.get("/auth/discord/start", (req, res) => {
      const old = cookieMap(req)[flowName] || "",
        flow = db
          .prepare("SELECT * FROM auth_flows WHERE hash=?")
          .get(digest(old));
      requireValue(
        flow?.kind === "preauth" && flow.expires_at > clock(),
        401,
        "Meld je eerst aan met je gebruikersnaam en wachtwoord.",
      );
      const state = token();
      db.prepare("DELETE FROM auth_flows WHERE hash=?").run(digest(old));
      db.prepare("INSERT INTO auth_flows VALUES(?,?,?,?)").run(
        digest(state),
        flow.user_id,
        "oauth",
        clock() + 5 * 60e3,
      );
      res.cookie(flowName, state, { ...cookies, maxAge: 5 * 60e3 });
      const params = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: config.origin + "/auth/discord/callback",
        response_type: "code",
        scope: "identify guilds.members.read",
        state,
        prompt: "consent",
      });
      res.redirect("https://discord.com/oauth2/authorize?" + params);
    });
    app.get("/auth/discord/callback", async (req, res) => {
      try {
        const state =
            typeof req.query.state === "string" ? req.query.state : "",
          bound = cookieMap(req)[flowName] || "";
        requireValue(
          state && state === bound,
          403,
          "Discord-aanmelding kon niet worden bevestigd.",
        );
        const flow = db
          .prepare("SELECT * FROM auth_flows WHERE hash=?")
          .get(digest(state));
        const signup = db
          .prepare("SELECT * FROM signup_flows WHERE hash=?")
          .get(digest(state));
        const direct = db
          .prepare("SELECT * FROM discord_login_flows WHERE hash=?")
          .get(digest(state));
        requireValue(
          (flow?.kind === "oauth" && flow.expires_at > clock()) ||
            (signup && signup.expires_at > clock()) ||
            (direct && direct.expires_at > clock()),
          401,
          "Deze aanmeldpoging is verlopen.",
        );
        db.prepare("DELETE FROM auth_flows WHERE hash=?").run(digest(state));
        db.prepare("DELETE FROM signup_flows WHERE hash=?").run(digest(state));
        db.prepare("DELETE FROM discord_login_flows WHERE hash=?").run(
          digest(state),
        );
        requireValue(
          !req.query.iss || req.query.iss === "https://discord.com",
          403,
          "Ongeldige Discord-provider.",
        );
        requireValue(
          typeof req.query.code === "string",
          401,
          "Discord-aanmelding is geannuleerd.",
        );
        const value = await exchange({
          grant_type: "authorization_code",
          code: req.query.code,
          redirect_uri: config.origin + "/auth/discord/callback",
          ...(direct ? { code_verifier: direct.verifier } : {}),
        });
        const tokens = {
          accessToken: value.access_token,
          refreshToken: value.refresh_token,
          expiresAt: clock() + value.expires_in * 1000,
        };
        const verified = await member(tokens);
        if (direct) {
          const user = await completeDiscordLogin(
            db,
            verified,
            config.roles.owner || [],
          );
          createSession(res, user, verified.tokens);
          res.clearCookie(flowName, cookies);
          audit(db, user, "sessie.discord_aangemeld", user.id);
          return res.redirect("/");
        }
        if (signup) {
          const policeRole = [
              ...(config.roles.police || []),
              ...(config.roles.command || []),
            ].some((role) => verified.roles.includes(role)),
            ambulanceRole = (config.roles.ambulance || []).some((role) =>
              verified.roles.includes(role),
            ),
            settings = getSettings(db);
          requireValue(
            policeRole || (ambulanceRole && settings.ambulanceEnabled),
            403,
            "Zelfregistratie is alleen beschikbaar voor politie en ingeschakelde ambulanceleden.",
          );
          requireValue(
            !db
              .prepare("SELECT id FROM users WHERE username=? OR discord_id=?")
              .get(signup.username, verified.identity.id),
            409,
            "Er bestaat al een account voor deze gebruikersnaam of Discord-identiteit. Meld je aan met je bestaande account.",
          );
          const user = {
            id: id(),
            username: signup.username,
            discord_id: verified.identity.id,
            password_hash: await hashPassword(token()),
            enabled: 1,
            must_change: 1,
            created_at: timestamp(),
          };
          transaction(db, () => {
            db.prepare(
              "INSERT INTO users(id,username,discord_id,password_hash,enabled,must_change,created_at) VALUES(?,?,?,?,1,1,?)",
            ).run(
              user.id,
              user.username,
              user.discord_id,
              user.password_hash,
              user.created_at,
            );
            audit(db, user, "account.zelfregistratie", user.id, null, {
              username: user.username,
            });
          });
          createSession(res, user, verified.tokens);
          res.clearCookie(flowName, cookies);
          res.redirect("/");
          return;
        }
        const user = db
          .prepare("SELECT * FROM users WHERE id=?")
          .get(flow.user_id);
        requireValue(
          user?.enabled && user.discord_id === verified.identity.id,
          403,
          "Koppel het Discord-account waarvoor dit overheidsaccount is aangemaakt.",
        );
        requireValue(
          Object.values(
            applyAccountAccess(
              permissions(
                verified.roles,
                getSettings(db),
                config.roles.owner || [],
              ),
              getAccountAccess(db, user.id),
              getSettings(db),
            ),
          ).some(Boolean),
          403,
          "Je mist een toegangsrol in de overheids-Discord.",
        );
        createSession(res, user, verified.tokens);
        res.clearCookie(flowName, cookies);
        audit(db, user, "sessie.aangemeld", user.id);
        res.redirect("/");
      } catch (error) {
        res.clearCookie(flowName, cookies);
        res.redirect(
          "/login.html?loginError=" +
            encodeURIComponent(
              error.status
                ? error.message
                : "Discord is tijdelijk niet bereikbaar.",
            ),
        );
      }
    });
    app.get("/api/me", auth, (req, res) =>
      res.json({
        user: publicUser(req.auth.user),
        permissions: req.auth.grants,
        csrf: req.auth.session.csrf,
        discordName:
          req.auth.identity.global_name || req.auth.identity.username,
        settings: { name: getSettings(db).name },
        demo: Boolean(config.demo),
        authMode: config.demo ? "password" : "discord",
      }),
    );
    app.post("/auth/logout", sameOrigin, (req, res) => {
      const hash = digest(cookieMap(req)[sessionName] || "");
      const session = db
        .prepare("SELECT * FROM sessions WHERE hash=?")
        .get(hash);
      if (session) {
        requireValue(
          req.get("x-csrf-token") === session.csrf,
          403,
          "Ongeldige beveiligingscode.",
        );
        const user = db
          .prepare("SELECT * FROM users WHERE id=?")
          .get(session.user_id);
        db.prepare("DELETE FROM sessions WHERE hash=?").run(hash);
        if (user) audit(db, user, "sessie.afgemeld", user.id);
      }
      clear(res);
      res.json({ ok: true });
    });
  }
  return { install, auth, csrf, permit, sameOrigin, clear, limit };
}
