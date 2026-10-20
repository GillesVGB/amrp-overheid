import { icon } from "./icons.js";
import { createApi } from "./api.js";
import { restoreAppearance } from "./appearance.js";
const $ = (id) => document.getElementById(id),
  api = createApi();
let checking = false;
restoreAppearance();
try {
  const name = localStorage.getItem("amrp-last-username");
  if (name) {
    $("default-account-name").textContent = name;
    $("username").value = name;
  }
} catch {
  /* Use default appearance when browser storage is unavailable. */
}
document.querySelectorAll("[data-icon]").forEach((element) => {
  element.innerHTML = icon(element.dataset.icon);
});
async function signin(switchAccount = false) {
  if (checking) return;
  checking = true;
  $("discord-signin").disabled = true;
  $("login-error").textContent = "";
  try {
    const result = await api("/auth/discord/login", {
      method: "POST",
      body: { switchAccount },
    });
    const target = new URL(result.oauthUrl);
    if (target.origin !== "https://discord.com")
      throw Error("Ongeldig aanmeldadres.");
    location.assign(target.href);
  } catch (error) {
    $("login-error").textContent = error.message;
  } finally {
    checking = false;
    $("discord-signin").disabled = false;
  }
}
$("discord-signin").addEventListener("click", () => signin());
$("switch-account").addEventListener("click", () => {
  $("username").value = "";
  $("password").value = "";
  $("username").focus();
});
$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $("password-signin");
  button.disabled = true;
  try {
    const result = await api("/auth/login", {
      method: "POST",
      body: { username: $("username").value, password: $("password").value },
    });
    try {
      localStorage.setItem("amrp-last-username", $("username").value.trim());
    } catch {}
    $("password").value = "";
    if (result.oauthUrl) location.assign(result.oauthUrl);
    else location.replace("/");
  } catch (error) {
    $("login-error").textContent = error.message;
  } finally {
    button.disabled = false;
  }
});
function closeFlyouts() {
  for (const [button, panel] of [
    ["login-network", "login-wifi-menu"],
    ["login-power", "login-power-menu"],
  ]) {
    $(panel).hidden = true;
    $(button).setAttribute("aria-expanded", "false");
  }
}
function updateNetwork() {
  $("login-network-state").textContent = navigator.onLine
    ? "Verbonden · beveiligde werkplek"
    : "Geen internetverbinding";
  $("login-network-detail").textContent = navigator.onLine
    ? "Amsterdam wifi is de naam van je werkplekverbinding. Je wifi-netwerk beheer je via Windows."
    : "Controleer je verbinding in Windows en probeer het opnieuw.";
  $("wifi-connected").hidden = !navigator.onLine;
}
$("login-network").addEventListener("click", () => {
  const open = $("login-wifi-menu").hidden;
  closeFlyouts();
  $("login-wifi-menu").hidden = !open;
  $("login-network").setAttribute("aria-expanded", String(open));
  updateNetwork();
});
$("login-power").addEventListener("click", () => {
  const open = $("login-power-menu").hidden;
  closeFlyouts();
  $("login-power-menu").hidden = !open;
  $("login-power").setAttribute("aria-expanded", String(open));
});
document.addEventListener("click", (event) => {
  if (
    event.target.closest("[data-close-flyout]") ||
    !event.target.closest(".login-flyout,#login-network,#login-power")
  )
    closeFlyouts();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeFlyouts();
    $("login-network").focus();
  }
});
window.addEventListener("online", updateNetwork);
window.addEventListener("offline", updateNetwork);
$("login-accessibility").addEventListener("click", () =>
  document.body.classList.toggle("high-contrast"),
);
$("login-close").addEventListener("click", () => {
  closeFlyouts();
  $("login").hidden = true;
  $("login-closed").hidden = false;
  $("login-return").focus();
  window.close();
});
$("login-return").addEventListener("click", () => {
  $("login-closed").hidden = true;
  $("login").hidden = false;
  $("discord-signin").focus();
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
  $("discord-signin").disabled = !health.discordConfigured || health.demo;
  const me = await api("/api/me");
  try {
    localStorage.setItem("amrp-last-username", me.user.username);
  } catch {
    /* Optional local display preference. */
  }
  location.replace("/");
} catch (error) {
  if (error.status !== 401) $("login-error").textContent = error.message;
}
