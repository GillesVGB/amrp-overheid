# Amsterdam Roleplay · Overheidsportaal

Een gedeelde digitale werkplek voor de Amsterdam Roleplay-overheidsdiensten. De interface gebruikt een Windows 11-bureaublad met Startmenu, taakbalk en verplaatsbare applicatievensters. Personeelsrollen komen uit Discord; roepnummers en standplaatsen zijn beheerbare werkgegevens.

## Wat erin zit

- Inloggen met gebruikersnaam en wachtwoord, met daaronder een aparte Discord-knop. De eigenaar maakt bij Accounts een gebruikersnaam, Discord-ID en wachtwoord aan en kiest de rechten. Het wachtwoord werkt direct; een verplichte eerste wijziging geldt alleen wanneer `mustChange` expliciet is ingesteld.
- Bij wachtwoordaanmelding worden ingestelde accountrechten direct toegepast; dienstrollen kunnen automatisch door de bot worden gecontroleerd. De browser hoeft daarvoor niet naar Discord. Directe Discord-aanmelding blijft beschikbaar en maakt bij een toegestane dienstrol automatisch een account aan. Uitgeschakelde accounts blijven bij beide methoden geblokkeerd.
- Meerdere appvensters naast elkaar, met behoud van open formulieren, taakbalk, minimaliseren, maximaliseren, slepen en vergroten. Met + in de titelbalk open je een extra venster van dezelfde app. MEOS opent als snelkoppeling naar de bestaande MEOS-website.
- Het Windows-aanmeldscherm heeft een wifi-menu met Amsterdam wifi en een afsluitoptie. Browsers die het sluiten van een tabblad blokkeren tonen een afsluitscherm.
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
- Verkenner met gedeelde en afgeschermde afdelingsmappen, uploaden en slepen van bestanden (maximaal 4 MB), voorvertoning en rapport-, aanvraag- en dienstverslagsjablonen. PDF, afbeeldingen, tekst en gecontroleerde Office-bestanden worden privé bewaard.
- Opleidingenregister met afrondingen, bevoegdheden en vervaldatums. Medewerkers dienen verlof-, opleidings- en materiaalaanvragen in; bevoegde leiding beoordeelt met een toelichting. Je eigen aanvraag kun je niet zelf goedkeuren.
- Zoek via Start of Ctrl+K naar toegankelijke medewerkers, roepnummers, documenten en opleidingen. Actieve overzichten controleren elke tien seconden op wijzigingen; open formulieren worden daarbij beschermd.
- CSV-import voor roepnummers controleert vooraf rangen, dubbele nummers en capaciteit. Gebruik de kolommen `Roepnummer,Rang`; maximaal 500 regels. Een bestand met fouten wordt niet gedeeltelijk opgeslagen.
- Concepten worden per account bewaard. Wachtwoorden, tokens en uploads komen niet in formulierconcepten.

## Zichtbare databasetabellen op Vercel

Bij het eerste API-verzoek wordt de bestaande database automatisch en atomair overgezet naar afzonderlijke PostgreSQL-tabellen in het schema `public`, waaronder `users`, `personnel`, `callsigns`, `workspace_folders`, `workspace_documents`, `training_courses`, `training_completions`, `employee_requests`, `form_drafts` en `audit`. Deze tabellen zijn daarna de bron van de gegevens en zijn rechtstreeks zichtbaar in Neon. De oude tabel `amrp_portal_state` blijft als migratieback-up bewaard en wordt niet verder bijgewerkt; verwijder die pas na een gecontroleerde back-up.

`amrp_portal_meta` bewaart schema-informatie en de gedeelde revisie. Verzoeken worden transactioneel verwerkt met een geïsoleerde SQLite-werkverbinding voor de bestaande applicatiecode en daarna vastgelegd in de PostgreSQL-tabellen. Dit voorkomt verlies van de bestaande accounts en koppelingen. Het is bedoeld voor deze gedeelde werkplek, niet voor grote aantallen gelijktijdige zware verzoeken. Geüploade bestanden blijven in private Vercel Blob; de tabellen bevatten hun metadata.

Een succesvolle Discord-rechtencontrole wordt maximaal dertig seconden gedeeld via de versleutelde serversessie. Tokenvernieuwing wordt samengevoegd bij gelijktijdige acties; na het verstrijken van de controletermijn worden rechten opnieuw bij Discord gecontroleerd.

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
3. Voeg onder **Settings → Environment Variables** de productievariabelen toe: `APP_ORIGIN` (`https://overheid.amsterdamrp.nl`, of je eigen HTTPS-domein), `TOKEN_ENCRYPTION_KEY`, `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID`, `ROLE_OWNER`, `ROLE_ADMIN`, `ROLE_POLICE` en `ROLE_COMMAND`. Genereer eenmalig een encryptiesleutel met `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"` en bewaar die permanent. De server-ID is `1402056739985162394`; de rollen zijn `ROLE_OWNER=1519394039361835239,1519394037423931392`, `ROLE_ADMIN=1519394041165516911`, `ROLE_POLICE=1519394082277953679` en `ROLE_COMMAND=1519394051760066660`. Vul `ROLE_AMBULANCE` alleen in als er een aparte ambulancerol is.
4. Stel ook `CRON_SECRET` in op een willekeurige geheime waarde. Vercel gebruikt deze om de geplande Discord-synchronisatie af te schermen. De meegeleverde planning draait dagelijks om 04:00 UTC. Vercel Hobby staat geen planning om de vijf minuten toe; daarvoor is een plan nodig dat frequentere Cron Jobs ondersteunt.
5. Voeg in Discord Developer Portal → OAuth2 de callback-URL `https://overheid.amsterdamrp.nl/auth/discord/callback` toe (vervang het domein als je een eigen domein gebruikt). De bot moet lid zijn van de server en leden kunnen lezen; geef de bot geen beheerdersrechten.
6. Open `/login.html` en kies **Inloggen met Discord**. Een Discord-account met een geconfigureerde `ROLE_OWNER` krijgt automatisch het eerste eigenaaraccount. Voor andere medewerkers gelden de dienstrollen of de expliciete rechten die de eigenaar bij Accounts instelt. De oude bootstraproute blijft alleen beschikbaar als expliciet geconfigureerde herstelmogelijkheid.
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
# Onderhoud en maker

Beheerders vinden in **Systeembeheer → Systeeminstellingen** de actie
**Site in onderhoud plaatsen**. Vul de publieke reden in. De instelling staat
centraal in de bestaande database en blokkeert ook API-toegang van gewone
medewerkers. Alleen admins/eigenaars behouden toegang; via `/admin` kunnen zij
aanmelden en met **Site weer openen** het onderhoud beëindigen. De reden blijft
beschikbaar op `/api/site-status` voor de statuswebsite, zonder beheerderssleutel.

Op het aanmeldscherm, de taakbalk en de onderhoudspagina staat **By Gilles** met
de Discord-avatar van `960090714950225970`. De avatar wordt periodiek ververst via
Lanyard; alleen de avatar-URL wordt aan de browser doorgegeven. Er is geen eigen
Discord-bot of extra geheim nodig voor de footer.

## Database tijdelijk niet beschikbaar

De Vercel-functie geeft bij databaseproblemen een JSON-fout met HTTP 503 terug.
`DATABASE_QUOTA_EXCEEDED` betekent dat Neon nieuwe verbindingen weigert omdat een
verbruikslimiet is bereikt. Controleer de gekoppelde database via **Vercel →
Storage → Neon → Open in Neon → Usage**. Het limiet moet daar worden opgelost;
een nieuwe websitedeploy herstelt een uitgeput quotum niet. Er wordt nooit een
lege vervangende database of een onterechte succesmelding gebruikt.

Publieke avatarcontroles gebruiken geen databaseverbinding. De onderhoudsstatus
leest bij een gemigreerd portaal alleen de opgeslagen instellingenrij, zonder
alle portaalgegevens te laden of een schrijftransactie te starten. Accountacties
en andere wijzigingen blijven de bestaande beveiligde transactie gebruiken.
