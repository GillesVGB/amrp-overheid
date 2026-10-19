# Amsterdam Roleplay · Overheidsportaal

Een gedeelde digitale werkplek voor de Amsterdam Roleplay-overheidsdiensten. De interface gebruikt een Windows 11-bureaublad met Startmenu, taakbalk en verplaatsbare applicatievensters. Personeelsrollen komen uit Discord; roepnummers en standplaatsen zijn beheerbare werkgegevens.

## Wat erin zit

- Inloggen met een intern account en controle van de Discord-identiteit en actuele serverrollen. Politie en korpsleiding kunnen zelf een account starten met hun Discord-rol; na controle kiezen ze hun eigen wachtwoord.
- Politieoverzicht, personeel, rangreeksen, roepnummers, standplaatsen, archief, accounts, instellingen en activiteitenlog.
- De Politie-app en Systeembeheer zijn aparte werkplekken. Politie opent standaard het dienstbord, ambulance de meldingen en de eigenaar het beheerstartscherm.
- Personeelsprofielen tonen rang, standplaats, roepnummer, status en de bij de laatste Discord-synchronisatie opgehaalde rollen. Vanuit een profiel kun je een vrij nummer koppelen of het Discord-profiel openen.
- Roepnummers blijven na verwijderen 30 minuten herstelbaar. Het activiteitenlog kan worden gefilterd op medewerker, actie, zoektekst en datum.
- Medewerkers kunnen per account een Windows-achtergrond kiezen; die keuze wordt op de server opgeslagen en verschijnt ook op het inlogscherm. Het inlogscherm onthoudt alleen de laatst gebruikte gebruikersnaam, nooit een wachtwoord.
- Ambulancewerkplek met afgeschermde RP-meldingen, eenheidstoewijzing, statusupdates en afronding. Voer geen echte medische persoonsgegevens in.
- Eigenaarrollen in `ROLE_OWNER` hebben volledige rechten en zijn als enige bevoegd om overheidsaccounts te beheren.
- Korpsleiding kan vrije roepnummers met meerdere tegelijk selecteren en verwijderen, of met de plusknop een nummer aan een specifieke reeks toevoegen.
- Achtergrondsynchronisatie met Discord en handmatige synchronisatie door bevoegde korpsleiding.
- Rangrollen zijn vooraf ingesteld in `server/discord-config.json` en `server/discord-ranks.json`.
- Automatische roepnummertoewijzing gebeurt alleen wanneer de Discord-naam bij een bestaand vrij nummer in de juiste rang past. Onzekere nummers verschijnen als controlepunt.

## Lokaal bekijken

Installeer Node.js 24.14 of nieuwer en voer in deze map uit:

```sh
npm ci
npm run dev:demo
```

Open daarna `http://127.0.0.1:4401`. De demo gebruikt verzonnen personeelsgegevens en is alleen bereikbaar via de eigen computer. De demoaccounts zijn `beheer`, `leiding` en `agent`; het demonstratiewachtwoord staat in de startmelding. Gebruik deze demoaccounts nooit in productie.

## Deployen naar Netlify

De productie-app draait als Netlify Function. De bijbehorende instellingen staan in `netlify.toml`; Netlify serveert de bestanden uit `public/` en stuurt `/api/*` en `/auth/*` naar de Express-function. De app bewaart de SQLite-databasesnapshot in Netlify Database (PostgreSQL) en archiefbestanden in Netlify Blobs. Verzoeken worden voor de database één voor één verwerkt, zodat deze bestaande SQLite-app met de serverless omgeving kan werken. Dit is bedoeld voor een kleine roleplay-omgeving; bij veel gelijktijdig gebruik is een normale PostgreSQL-datalaag geschikter.

1. Koppel de GitHub-repository `GillesVGB/amrp-overheid` aan Netlify en deploy de branch `main`. De buildinstellingen komen uit `netlify.toml`.
2. Open in Netlify **Data & Storage → Database** en maak de database voor dit project aan. De function gebruikt de automatisch gekoppelde database. Netlify Blobs wordt bij de eerste function-aanroep aangemaakt.
3. Stel in Netlify **Project configuration → Environment variables** de productievariabelen in. Zet `APP_ORIGIN` op `https://overheid.amsterdamrp.nl`; genereer `TOKEN_ENCRYPTION_KEY` met `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"`. Bewaar dezelfde encryptiesleutel permanent.

   Voeg ook `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_BOT_TOKEN` en `DISCORD_GUILD_ID` toe. De server-ID is `1402056739985162394`. De rollen kunnen in Netlify worden ingesteld als `ROLE_OWNER=1519394039361835239,1519394037423931392`, `ROLE_ADMIN=1519394041165516911`, `ROLE_POLICE=1519394082277953679` en `ROLE_COMMAND=1519394051760066660`. Vul `ROLE_AMBULANCE` in als er een aparte ambulancerol is en schakel de ambulancewerkplek in bij de systeeminstellingen om ambulanceleden te laten aanmelden.

4. Voeg in de Discord Developer Portal bij OAuth2 deze exacte redirect-URL toe: `https://overheid.amsterdamrp.nl/auth/discord/callback`. De bot moet lid zijn van de server en leden kunnen lezen. Geef de bot geen beheerdersrechten.
5. Voeg tijdelijk de geheime variabele `NETLIFY_BOOTSTRAP_KEY` toe met een zelf gegenereerde willekeurige waarde van minstens 32 tekens. Deploy opnieuw. Maak daarna precies één eerste beheeraccount via `POST https://overheid.amsterdamrp.nl/api/first-account` met JSON-velden `username`, `discordId` en `password`, en met de header `x-initial-setup-key` gelijk aan die tijdelijke sleutel. Het Discord-ID van het beheerdersaccount is `960090714950225970`; kies een tijdelijk wachtwoord van minstens 12 tekens. Verwijder `NETLIFY_BOOTSTRAP_KEY` daarna uit Netlify en deploy opnieuw. De eerste aanmelding vraagt om een nieuw wachtwoord.
6. Koppel in Netlify het domein `overheid.amsterdamrp.nl` en stel de DNS-records in die Netlify voor het domein toont. Controleer daarna de OAuth-login, Discord-rollen, archiefuploads en scheduled function `discord-sync`.

Bewaar OAuth-secrets, de bottoken, encryptiesleutel en bootstrap-sleutel alleen in Netlify Environment Variables. Zet ze nooit in Git, screenshots of berichten. De scheduled Discord-synchronisatie draait elke vijf minuten. Verzoeken en bestanden blijven beschikbaar bij nieuwe deploys.

## Handige commando's

```sh
npm run check       # controleert JavaScript-syntaxis
npm test            # integratie- en beveiligingstests
npm run build       # controle voor de Netlify-build
npm start           # lokale server met waarden uit .env
```

Voor lokale productie- of Docker-hosting kun je `.env.example` naar `.env` kopiëren en de Discord- en serverwaarden invullen. De map `data/` en uploads moeten dan op een blijvend volume staan. Maak periodiek een beveiligde back-up.
