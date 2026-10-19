# Amsterdam Roleplay · Overheidsportaal

Een beveiligde, gedeelde digitale werkplek voor de Amsterdam Roleplay-overheidsdiensten. De interface gebruikt een Windows 11-bureaublad, een Startmenu, een taakbalk en verplaatsbare applicatievensters. Personeelsrollen komen uit Discord; roepnummers en standplaatsen zijn beheerbare werkgegevens.

## Wat erin zit

- Inloggen met een intern account én controle van de Discord-identiteit en actuele serverrollen.
- Politieoverzicht, personeel, rangreeksen, roepnummers, standplaatsen, archief, accounts, instellingen en activiteitenlog.
- Ambulancewerkplek met afgeschermde RP-meldingen, eenheidstoewijzing, statusupdates en afronding. Voer geen echte medische persoonsgegevens in.
- Eigenaarrollen in `ROLE_OWNER` hebben blijvend volledige rechten, ook als de gewone ambulancewerkplek is uitgeschakeld.
- Discord-personeelsynchronisatie op de achtergrond en handmatig door bevoegde korpsleiding.
- Rolniveaus en Discord-rangrollen zijn vooraf ingesteld in `server/discord-config.json` en `server/discord-ranks.json`.
- Automatische roepnummertoewijzing wordt alleen gedaan wanneer de Discord-naam bij een bestaand vrij nummer in de juiste rang past. Onzekere nummers verschijnen als controlepunt.
- Discord bevat geen betrouwbare standplaatsinformatie. De korpsleiding vult de standplaats in via Personeel of Roepnummers.
- SQLite slaat gegevens en uploads op in `data/`. Zet die map op een blijvend volume bij hosting.

## Lokaal bekijken

Installeer Node.js 24.14 of nieuwer en voer in deze map uit:

```sh
npm ci
npm run dev:demo
```

Open daarna `http://127.0.0.1:4401`. De demo gebruikt alleen verzonnen personeelsgegevens en een afgeschermde loopbackverbinding. De demoaccounts zijn `beheer`, `leiding` en `agent`; het demonstratiewachtwoord staat in de startmelding. Gebruik deze demoaccounts nooit in productie.

## Beveiligde productie-installatie

Deze app gebruikt sessies, bestanden en SQLite-opslag. Host haar op een VPS of andere server met blijvende opslag en HTTPS. Een statische Netlify-site is geen geschikte plek voor deze backend.

1. Maak in Discord Developer Portal een OAuth2-app en voeg als redirect-URL exact `https://JOUW-DOMEIN/auth/discord/callback` toe. De bot moet lid zijn van de opgegeven Discord-server en leden kunnen lezen.
2. Kopieer `.env.example` naar `.env`. Vul daarin de publieke origin, OAuth Client ID en Client Secret, bottoken, server-ID en rol-ID's in. Bewaar geheimen alleen in `.env` of de geheime variabelen van je hostingprovider.
3. Maak een unieke versleutelingssleutel met `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"` en zet die in `TOKEN_ENCRYPTION_KEY`. Bewaar deze sleutel permanent; opgeslagen Discord-sessies kunnen er anders niet meer mee worden gelezen.
4. Start met Docker Compose: `docker compose up -d --build`. De app luistert intern op poort 4400; publiceer die via een HTTPS-reverseproxy. De map `data/` blijft bewaard tussen herstarts.
5. Maak op de serverterminal het eerste account met `docker compose exec overheid npm run account:create` (of `npm run account:create` als Node rechtstreeks op de server draait). Het standaardaccount is gekoppeld aan het opgegeven Discord-beheerdersaccount. Het wachtwoord wordt verborgen ingevoerd en moet bij de eerste aanmelding worden gewijzigd.
6. Controleer in de Discord Developer Portal dat de bot nog in de server staat. Bij een ledenleesfout zet je ook de Server Members Intent aan. De bot hoeft geen beheerdersrechten te krijgen.

Zet `APP_ORIGIN` op de uiteindelijke `https://`-URL voordat je de productie-app start. Die URL moet exact overeenkomen met de OAuth2-redirect-URL. Verwijder of publiceer `.env` nooit; het bestand staat in `.gitignore`.

## Handige commando's

```sh
npm run check       # controleert JavaScript-syntaxis
npm test            # integratie- en beveiligingstests
npm start           # productie-app, met waarden uit .env
```

Maak periodiek een beveiligde back-up van zowel `data/portal.sqlite` als `data/uploads/`. Beperk toegang tot de back-up tot bevoegde beheerders.
