# Landskrona inspektionsrapporter

MCP-server för Intric. Tar emot en färdig rapport, fyller en bearbetad Word-mall och returnerar en nedladdningslänk. Förberedd för Vercel med privat Vercel Blob-lagring.

## Starta testet på Vercel

1. Packa upp projektet. Lägg innehållet i ett Git-repository som du importerar i Vercel. Projektroten ska innehålla `package.json`, `vercel.json`, `api/`, `src/` och `templates/`.
2. Välj **Other** som Framework Preset. Lämna Build Command och Output Directory utan egen override. Installationen använder `npm install`. Node-version: **22.x**.
3. Under **Storage**, skapa eller anslut ett **privat** Vercel Blob-lager. Ange lagrets `BLOB_READ_WRITE_TOKEN` som miljövariabel om den inte kopplas automatiskt. Ett publikt lager fungerar inte med serverns privata uppladdningar.
4. Lägg till miljövariablerna nedan. Två separata hemligheter kan skapas lokalt med `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`, en gång per hemlighet.
5. Deploya. När du vet projektets adress, kontrollera `PUBLIC_BASE_URL` och gör **Redeploy** efter ändringar av miljövariabler.
6. Öppna `https://DITT-PROJEKT.vercel.app/api/health`. Svaret ska vara `{"status":"ok","templates":8}`. Hälsokontrollen kontrollerar inställningar, inte att Blob-token har fungerande åtkomst; det prövas när första rapporten skapas.
7. Anslut Intric enligt nästa avsnitt och skapa testrapporten. Klicka på länken och öppna filen i Word.

| Miljövariabel | Värde i Vercel |
| --- | --- |
| `MCP_API_KEY` | Egen slumpnyckel, minst 32 tecken |
| `DOWNLOAD_SECRET` | En annan slumpnyckel, minst 32 tecken |
| `PUBLIC_BASE_URL` | `https://DITT-PROJEKT.vercel.app`, utan sökväg |
| `STORAGE_DRIVER` | `blob` |
| `BLOB_READ_WRITE_TOKEN` | Token till det privata Blob-lagret |
| `DOWNLOAD_TTL_SECONDS` | `3600` för en timme, tillåtet 60–86400 |

Vercels eventuella Deployment Protection måste tillåta Intric och användaren att nå denna deployment. Använd produktionsadressen vid första testet. Serverns egen API-nyckel skyddar rapportgenereringen.

## Anslut till Intric

Som administratör med MCP-modulen aktiverad:

1. Skapa en MCP-server, exempelvis **Landskrona rapporter**.
2. URL: `https://DITT-PROJEKT.vercel.app/api/mcp`.
3. Välj autentisering **API key** och klistra in värdet från `MCP_API_KEY`. Intric skickar det som `Authorization: Bearer ...`.
4. Validera anslutningen och uppdatera serverns verktyg med **Refresh capabilities**.
5. Aktivera servern under Tools och lägg till den hos assistenten.
6. Lägg instruktionen från `INTRIC-INSTRUKTION.md` i assistentens instruktioner.

Transporten är **Streamable HTTP**, utan bestående server-session. Verktygen heter `list_templates` och `create_inspection_report`. Det finns ingen separat `/sse`-endpoint.

Verktyget lämnar både text med `download_url` och en MCP-resurslänk. Assistenten ska visa URL:en som klickbar länk. Detta förutsätter inte att Intric importerar filen som en egen bilaga; hur resurslänken visas i just din Intric-version måste verifieras i testet.

## Mallval och innehåll

| Rapporttyp | `report_type` |
| --- | --- |
| Skola, även standardmall | `skola` |
| Skola energitillsyn | `skola_energi` |
| Förskola | `forskola` |
| Livsmedelsverksamhet | `livsmedel` |
| Avfallsverksamhet | `avfall` |
| Avfallsverksamhet bilskrot | `avfall_bilskrot` |
| Yrkesmässig hygienisk verksamhet | `hygienisk_verksamhet` |
| Solarium | `solarium` |

Svenska mallnamn accepteras också. Saknad eller okänd typ väljer alltid **Skola** och den titel som anropet anger. Svaret anger `fallback_used: true`. Tom rapporttext ger ett fel, aldrig en gammal rapport som ersättning.

`title` är obligatorisk. Skicka exakt ett av `report_text` och `sections`. Resten är valfria uppgifter. Saknade uppgifter lämnas tomma och anges i svarets `warnings`. Inga namn, datum, beslut, laghänvisningar, avgifter eller digitala godkännanden hämtas från gamla rapporter.

`examples/report.json` är ett komplett fiktivt exempel. `report_text` stöder stycken, radbrytningar, rubriker med `#` och enkla listor med `-`. Det är inte en fullständig Markdown- eller HTML-konverterare. `sections` ger säkrare kontroll över rubriker och ordning.

För livsmedel kan anropet dessutom innehålla:

```json
"food_summary": {
  "passed": "Kontrollerade punkter utan avvikelser",
  "follow_up": "Uppföljning av tidigare avvikelser",
  "deviations": "Konstaterade avvikelser"
}
```

Det fyller originalrapportens tvåspaltiga sammanställning med dess befintliga tabellstil. Utelämna objektet om ingen sådan sammanställning ska visas. Varje textfält kan lämnas tomt; servern hittar inte på ett godkänt eller underkänt resultat.

## Vad som bevaras i Word

De tio källfilerna innehöll åtta unika dokument. De två `(1)`-filerna var identiska dubbletter. Bearbetade mallar ingår i `templates/`; originalrapporterna ingår inte och har inte ändrats.

Brevhuvudets struktur, kontaktuppgifter, logotyp, sidformat, marginaler, sidhuvud/sidfot och textstilar kommer från respektive original. Logotypens befintliga PNG-variant används med oförändrad storlek och placering för stabil visning i Word. Titel, mottagare, datum, handläggare och ärendenummer ersätts. Ny rapporttext använder originalets rubrik- och brödtextformat. Textmängden styr sidantalet. Sidnummerfält uppdateras när Word öppnar dokumentet.

Gamla rapportavsnitt, mottagarlistor, bilagor, kommentarer och personliga dokumentegenskaper har rensats. Servern kopierar inte de färdigskrivna rapporternas slutsatser eller standardtext. All sådan text måste skickas från Intric om den ska finnas i den nya rapporten.

Livsmedelssammanställningens tabell kan fyllas via `food_summary`. Gamla statussymboler, fria illustrationer och detaljtabeller kopieras inte automatiskt. Versionen hanterar textbaserade rapporter och denna sammanställning; foto-bilagor, godtyckliga tabeller och avancerad riktext kräver separata mallfält. Layouten följer respektive mall, men är inte en kopia sida för sida av ett gammalt ärende.

## Testa lokalt

Installera Node.js 22. Kopiera `.env.example` till `.env.local`, fyll i två olika slumpnycklar och behåll `STORAGE_DRIVER=local` och `PUBLIC_BASE_URL=http://localhost:3000`.

```sh
npm ci
npm test
npm run dev
```

Ingen Blob-token behövs lokalt. Ett alternativ till MCP är att anropa `POST /api/reports` med samma rapportdata. I PowerShell:

```powershell
$headers = @{ Authorization = "Bearer DIN_MCP_API_KEY" }
$body = Get-Content -Raw -Encoding utf8 examples/report.json
$result = Invoke-RestMethod -Uri http://localhost:3000/api/reports -Method Post -Headers $headers -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body))
Start-Process $result.download_url
```

Byt adressen för att köra samma test mot Vercel.

## Lagring och radering

På Vercel sparas rapporter privat i Blob. API-nyckeln krävs för att skapa dokument. Nedladdningen använder en separat signerad länk som fungerar utan API-nyckel; den som har länken kan ladda ner dokumentet fram till dess att länken går ut.

Utgången länk betyder inte automatisk radering. `POST /api/cleanup` med API-nyckeln raderar rapporter vars länkar gått ut. Alternativt kör `npm run cleanup` med Blob-inställningarna i `.env.local`. Anropa cleanup återkommande via er scheduler om regelbunden radering behövs. Ingen schemaläggning skapas automatiskt av detta projekt. Cleanup rör endast utgångna filer i serverns `reports/`-namnrymd.

Rapporttext och hemligheter loggas inte av applikationen. Plattformens egna åtkomstloggar kan innehålla URL:er, inklusive nedladdningstoken. Länkar ska därför hanteras som tillfälliga åtkomstnycklar.

## Verifiering och kvarvarande miljötest

De automatiska testerna använder en riktig MCP-klient och lokal lagring. De prövar anslutning, verktygslista, dokumentgenerering, nedladdning, alla mallval, reservval, saknat innehåll, API-nyckel, utgångna/manipulerade länkar, samtidiga rapporter och isolerad radering. Word-exempel har öppnats och renderats i Microsoft Word lokalt för visuell kontroll. Skadade paketreferenser kontrolleras separat.

Vercel-deployment, det privata Blob-lagret och anslutningen i ditt Intric-konto behöver testas i din miljö. Inga molnkonton har kopplats eller ändrats av denna leverans.

## Dokumentation

- [Intric: anslut egen MCP-server](https://help.intric.ai/en/docs/tools-and-integrations/mcp-server/connecting-your-own-mcp-server/)
- [Vercel: privata Blob-filer](https://vercel.com/docs/vercel-blob/private-storage)
- [Vercel: MCP-servrar](https://vercel.com/docs/mcp/deploy-mcp-servers-to-vercel)
