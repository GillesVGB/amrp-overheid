# Onderhoud via de statuswebsite

Stel `STATUS_CONTROL_SECRET` in als apart servergeheim van minstens 32 tekens. De statuswebsite gebruikt dezelfde waarde als `OVERHEID_STATUS_CONTROL_SECRET`.

`PUT /api/status-control/maintenance` accepteert alleen de aparte Bearer-sleutel en JSON met `enabled` (boolean) en `reason` (string, 5–500 tekens bij inschakelen). De route wijzigt alleen de bestaande onderhoudsinstelling en schrijft een auditregel met actor “Statuswebsite · beheerder”. Overige instellingen en sessies blijven behouden. Zonder geconfigureerde sleutel is de route uitgeschakeld.

De bestaande `/api/maintenance` blijft de eigen beheersessie, CSRF-controle en rechten vereisen. `/api/site-status` geeft alleen de publieke onderhoudsstatus terug. Bij onderhoud blijven bestaande overheidsbeheerders toegang houden; gewone gebruikers krijgen de onderhoudspagina. Zet geen van deze servergeheimen in de browser of Git.
