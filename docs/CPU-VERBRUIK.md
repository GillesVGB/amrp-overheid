# CPU-besparing overheidsportaal

## Verwerking van aanvragen

- Het hoofdbureaublad controleert wijzigingen eenmaal per minuut en deelt ze alleen met eigen appvensters van dezelfde origin. Appvensters doen geen eigen polling meer.
- De sessiecontrole loopt eenmaal per vijf minuten, met een begrensde controle bij terugkeer. Alle beveiligde serverroutes blijven zelfstandig de actuele account- en Discordrechten controleren; de bestaande verificatiegrens van dertig seconden blijft gelden.
- Meldingen vernieuwen bij een gewijzigde revisie, openen van het meldingscentrum of een gebruikersactie. Verborgen tabbladen pollen niet.
- `api/portal.mjs` behandelt openbare status/profielfoto en beveiligde `/api/changes` en `/api/me` voordat de volledige applicatie wordt gestart.
- Beveiligde controles lezen alleen de huidige instellingen, gebruiker, accountrechten en sessie. Ze gebruiken dezelfde authenticatiemiddleware, antwoordprojectie en transactievergrendeling als de applicatie. Tokenrotatie en ingetrokken sessies worden eerst opgeslagen. Privéantwoorden zijn altijd `private, no-store`.
- Alleen de openbare onderhoudsstatus en profielfoto mogen kort in de browser/CDN worden gecachet. Gegevens, sessies, personeelsinformatie, beheerinformatie en bestanden komen niet in de publieke cache.
- Gewone databaseverwerking vermijdt een tweede volledige scan/hash wanneer noch gegevens noch schema zijn gewijzigd. Migraties, herstel, terugrollen en relationele controles blijven actief.

## Controle van de besparing

Bij twaalf uur onafgebroken zichtbare werkplek, zonder gebruikersacties of gewijzigde gegevens, daalt het codegebaseerde aantal periodieke aanvragen van circa 23.040 met drie geopende apps naar 2.304, vóór de publieke caches. Extra appvensters voegen geen periodieke aanvragen toe. Dit is ongeveer 90% minder.

Een lokale test met een nagebootste PostgreSQL-pool mat voor de lichte revisieroute circa 1,7–1,9 ms proces-CPU per warme aanvraag. De oorspronkelijke volledige route gebruikte circa 167 ms bij de kleine testdataset en 241 ms met 1.000 auditregels. Deze cijfers zijn geen Vercel-metingen; netwerk, cold starts en werkelijk verkeer verschillen.

Voor de algemene volledige databaseverwerking liet dezelfde lokale vergelijking circa 28–47% minder proces-CPU zien, afhankelijk van de dataset. De omvang van de volledige database blijft wel relevant voor inhoudelijke acties.

Een verbruik van maximaal één minuut Active CPU per twaalf uur is niet gegarandeerd. Daarvoor moet na publicatie en heropening een vergelijkbare periode worden gemeten, met bezoekersaantal en gebruikersacties erbij. De site is tijdens deze wijziging gepauzeerd gehouden; een productieperiode na de wijziging is daarom nog niet beschikbaar.

## Verificatie

`npm test` controleert onder meer accounttoegang, Discordrechten, sessie-intrekking, tokenvernieuwing, CSRF, onderhoud, MEOS, documenten, imports, migraties en gedeelde vensters. `npm run check` controleert de JavaScript-syntaxis. De SQL-projectie van de lichte routes is tevens met een alleen-lezen query gecontroleerd in Supabase. Deze wijziging voert geen gegevensmigratie of opschoning uit.
