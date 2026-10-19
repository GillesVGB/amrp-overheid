import { icon } from "./icons.js";
import { createApi } from "./api.js";
const $ = (id) => document.getElementById(id),
  api = createApi();
const rememberedUsername = (() => {
  try {
    return localStorage.getItem("amrp-last-username") || "";
  } catch {
    return "";
  }
})();
const defaultUsername = rememberedUsername;
function rememberUsername(value) {
  try {
    localStorage.setItem("amrp-last-username", value.trim());
  } catch {
    // The display name is optional; credentials are never stored.
  }
}
try {
  const wallpaper = localStorage.getItem("amrp-wallpaper");
  if (wallpaper)
    document.querySelectorAll(".wallpaper").forEach((element) => {
      element.dataset.wallpaper = wallpaper;
    });
} catch {
  // Use the default wallpaper when storage is unavailable.
}
$("default-account-name").textContent = defaultUsername || "Gebruiker";
$("login-name").textContent = rememberedUsername || "Aanmelden";
$("username").value = defaultUsername;
$("username").hidden = Boolean(rememberedUsername);
$("other-user").hidden = !rememberedUsername;
document
  .querySelectorAll("[data-icon]")
  .forEach((el) => (el.innerHTML = icon(el.dataset.icon)));
$("other-user").addEventListener("click", () => {
  $("login-form").hidden = false;
  $("other-user").hidden = true;
  $("login-name").textContent = "Andere gebruiker";
  $("username").hidden = false;
  $("username").value = "";
  $("username").focus();
});
$("switch-account").addEventListener("click", () => {
  $("login-form").hidden = false;
  $("other-user").hidden = true;
  $("login-name").textContent = "Andere gebruiker";
  $("username").hidden = false;
  $("username").value = "";
  $("username").focus();
  document
    .querySelectorAll(".login-profile")
    .forEach((x) => x.classList.toggle("selected", x.id === "switch-account"));
});
$("default-account").addEventListener("click", () => {
  $("login-name").textContent = defaultUsername || "Gebruiker";
  $("login-form").hidden = false;
  $("other-user").hidden = true;
  $("username").hidden = Boolean(defaultUsername);
  $("username").value = defaultUsername;
  if (defaultUsername) $("password").focus();
  else $("username").focus();
  document
    .querySelectorAll(".login-profile")
    .forEach((x) => x.classList.toggle("selected", x.id === "default-account"));
});
$("register-toggle").addEventListener("click", () => {
  $("login-form").hidden = true;
  $("register-toggle").hidden = true;
  $("register-form").hidden = false;
  $("login-error").textContent = "";
  $("login-name").textContent = "Account aanmaken";
  $("register-username").focus();
});
$("register-cancel").addEventListener("click", () => {
  $("register-form").hidden = true;
  $("register-toggle").hidden = false;
  $("login-form").hidden = false;
  $("login-name").textContent = defaultUsername || "Aanmelden";
  $("login-error").textContent = "";
});
$("register-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.target.querySelector('[type="submit"]');
  button.disabled = true;
  $("login-error").textContent = "";
  try {
    const values = Object.fromEntries(new FormData(event.target));
    const result = await api("/auth/register", {
      method: "POST",
      body: values,
    });
    rememberUsername(values.username);
    location.assign(result.oauthUrl);
  } catch (error) {
    $("login-error").textContent = error.message;
  } finally {
    button.disabled = false;
  }
});
$("login-network").addEventListener("click", () => {
  $("login-error").textContent = navigator.onLine
    ? "Netwerkverbinding beschikbaar."
    : "Er is geen netwerkverbinding.";
});
$("login-accessibility").addEventListener("click", () =>
  document.body.classList.toggle("high-contrast"),
);
$("login-power").addEventListener("click", () => {
  $("login-error").textContent =
    "Je kunt dit browservenster sluiten. Je computer wordt niet afgesloten.";
});
$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.target.querySelector("button");
  button.disabled = true;
  $("login-error").textContent = "";
  try {
    const values = Object.fromEntries(new FormData(event.target));
    const result = await api("/auth/login", {
      method: "POST",
      body: values,
    });
    rememberUsername(values.username);
    $("default-account-name").textContent = values.username;
    $("password").value = "";
    if (result.oauthUrl) {
      $("login-form").hidden = true;
      $("discord-connect").hidden = false;
      $("login-name").textContent = "Bevestig je identiteit";
      $("login-error").textContent =
        "Je wachtwoord klopt. Ga verder met je gekoppelde Discord-account.";
    } else location.replace("/");
  } catch (error) {
    $("login-error").textContent = error.message;
  } finally {
    button.disabled = false;
  }
});
const parameters = new URLSearchParams(location.search),
  message = parameters.get("loginError") || parameters.get("melding");
if (message) {
  $("login-error").textContent = message;
  history.replaceState(null, "", "/login.html");
}
try {
  const health = await api("/api/health");
  $("setup-notice").hidden = health.discordConfigured || health.demo;
  $("register-toggle").hidden = !health.discordConfigured || health.demo;
  await api("/api/me");
  location.replace("/");
} catch (error) {
  if (error.status !== 401) $("login-error").textContent = error.message;
}
