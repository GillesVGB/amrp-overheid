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

## Deployen naar Vercel

De repository bevat Vercel Functions voor `/api/*` en `/auth/*`. Vercel serveert de websitebestanden uit `public/`. De app bewaart haar database blijvend in PostgreSQL en personeelsbestanden in een **private** Vercel Blob-store. Maak beide opslagdiensten aan en koppel ze aan hetzelfde Vercel-project voordat je de eerste productieaanmelding gebruikt.

1. Importeer `GillesVGB/amrp-overheid` in Vercel en deploy de branch `main`. `vercel.json` bevat de statische map, routes en de dagelijkse Discord-synchronisatie.
2. Open het Vercel-project → **Storage**. Maak via de Marketplace een PostgreSQL-database aan, bijvoorbeeld Neon, en koppel deze aan het project. De integratie moet `POSTGRES_URL` of `DATABASE_URL` toevoegen. Maak ook een Vercel Blob-store met toegang **Private** en koppel die aan het project; Vercel voegt dan `BLOB_READ_WRITE_TOKEN` toe. De site bewaart databasegegevens in PostgreSQL en gevoelige uploads alleen in private Blob-opslag.
3. Voeg onder **Settings → Environment Variables** de productievariabelen toe: `APP_ORIGIN` (`https://amrp-overheid.vercel.app`, of je eigen HTTPS-domein), `TOKEN_ENCRYPTION_KEY`, `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID`, `ROLE_OWNER`, `ROLE_ADMIN`, `ROLE_POLICE` en `ROLE_COMMAND`. Genereer eenmalig een encryptiesleutel met `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"` en bewaar die permanent. De server-ID is `1402056739985162394`; de rollen zijn `ROLE_OWNER=1519394039361835239,1519394037423931392`, `ROLE_ADMIN=1519394041165516911`, `ROLE_POLICE=1519394082277953679` en `ROLE_COMMAND=1519394051760066660`. Vul `ROLE_AMBULANCE` alleen in als er een aparte ambulancerol is.
4. Stel ook `CRON_SECRET` in op een willekeurige geheime waarde. Vercel gebruikt deze om de geplande Discord-synchronisatie af te schermen. De meegeleverde planning draait dagelijks om 04:00 UTC. Vercel Hobby staat geen planning om de vijf minuten toe; daarvoor is een plan nodig dat frequentere Cron Jobs ondersteunt.
5. Voeg in Discord Developer Portal → OAuth2 de callback-URL `https://amrp-overheid.vercel.app/auth/discord/callback` toe (vervang het domein als je een eigen domein gebruikt). De bot moet lid zijn van de server en leden kunnen lezen; geef de bot geen beheerdersrechten.
6. Stel tijdelijk `INITIAL_SETUP_KEY` in met een willekeurige geheime waarde van minstens 32 tekens en deploy opnieuw. Maak één eerste beheeraccount via `POST https://amrp-overheid.vercel.app/api/first-account`, met JSON-velden `username`, `discordId` en `password` en de header `x-initial-setup-key` gelijk aan de tijdelijke sleutel. Het Discord-ID is `960090714950225970`; kies een tijdelijk wachtwoord van minstens 12 tekens. Verwijder `INITIAL_SETUP_KEY` daarna en deploy opnieuw. De eerste aanmelding vraagt om een nieuw wachtwoord.
7. Controleer daarna de Discord-login, rolcontrole, databasepersistentie, private archiefuploads en geplande synchronisatie in de Vercel Logs.

Bewaar OAuth-secrets, bottoken, database-URL, Blob-token, encryptiesleutel en tijdelijke instelsleutel uitsluitend in Vercel Environment Variables. Commit ze nooit naar Git en deel ze niet in screenshots of berichten. De PostgreSQL-database en Blob-store blijven behouden wanneer je opnieuw deployt.

## Handige commando's

```sh
npm run check       # controleert JavaScript-syntaxis
npm test            # integratie- en beveiligingstests
npm run build       # controle voor de productiebuild
npm start           # lokale server met waarden uit .env
```

Voor lokale productie- of Docker-hosting kun je `.env.example` naar `.env` kopiëren en de Discord- en serverwaarden invullen. De map `data/` en uploads moeten dan op een blijvend volume staan. Maak periodiek een beveiligde back-up.
