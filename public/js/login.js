import { icon } from "./icons.js";
import { createApi } from "./api.js";
const $ = (id) => document.getElementById(id),
  api = createApi();
document
  .querySelectorAll("[data-icon]")
  .forEach((el) => (el.innerHTML = icon(el.dataset.icon)));
$("other-user").addEventListener("click", () => {
  $("login-form").hidden = false;
  $("other-user").hidden = true;
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
  $("login-name").textContent = "Gebruiker";
  $("login-form").hidden = false;
  $("other-user").hidden = true;
  $("username").hidden = true;
  $("username").value = "gilles";
  $("password").focus();
  document
    .querySelectorAll(".login-profile")
    .forEach((x) => x.classList.toggle("selected", x.id === "default-account"));
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
    const result = await api("/auth/login", {
      method: "POST",
      body: Object.fromEntries(new FormData(event.target)),
    });
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
  await api("/api/me");
  location.replace("/");
} catch (error) {
  if (error.status !== 401) $("login-error").textContent = error.message;
}
