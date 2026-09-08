# Verifiering

Testdatum: 7 september 2026.

- 10 automatiska tester godkända med Node.js 22, samma huvudversion som Vercel-konfigurationen.
- Riktig MCP-klient användes för initialize, tools/list, tools/call och nedladdning.
- Alla åtta malltyper testades, inklusive okänd/saknad typ och ny titel.
- Saknat innehåll, motstridiga fält, stora anrop, kontrolltecken och otillåten origin avvisades.
- Signerade länkar testades med ändrad signatur, utgången giltighet och otillåtna filidentifierare.
- Samtidiga anrop gav separata filer. Filer kunde läsas via en annan serverinstans med samma lagring.
- Cleanup raderade endast utgångna rapporter.
- DOCX-paketens XML, interna länkar och nödvändiga Word-delar kontrollerades. Originalens stilar och numreringsdefinitioner bevarades.
- Originalfilerna är oförändrade enligt SHA-256. Äldre ärendetext och datum kontrollerades efter rensningen.
- Word-filer för alla mallar, livsmedelstabellen och ett flersidigt exempel öppnades och exporterades med Microsoft Word. Layouten granskades i sidbilder.
- `npm audit --omit=dev --audit-level=high` rapporterade inga kända sårbarheter vid testet.

Vercel Blob och Intric har inte testats mot ett verkligt konto. De stegen finns i README. Lokal testlagring ersätter Blob i de automatiska integrationstesterna.
