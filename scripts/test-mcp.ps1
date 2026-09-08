# Testar rapportverktyget direkt mot produktion, utan Intric.
# Kor fran projektroten:  .\scripts\test-mcp.ps1
# Nyckeln lases ur .env.vercel och skrivs aldrig ut.

$ErrorActionPreference = 'Stop'
$envFile = Join-Path $PSScriptRoot '..\.env.vercel'
if (-not (Test-Path $envFile)) { throw "Hittar inte .env.vercel i projektroten." }

$key = (Select-String -Path $envFile -Pattern '^MCP_API_KEY=(.+)$').Matches.Groups[1].Value.Trim()
if (-not $key) { throw "MCP_API_KEY saknas i .env.vercel." }
Write-Host "Nyckel inlast ($($key.Length) tecken)." -ForegroundColor DarkGray

$url = 'https://landskrona-mcp.vercel.app/mcp'
$headers = @{
  'Authorization' = "Bearer $key"
  'Content-Type'  = 'application/json'
  'Accept'        = 'application/json, text/event-stream'
}

# Reproducerar exakt det anrop som misslyckades i Intric:
# rapporttypen avfall tillsammans med ett tomt food_summary.
$payload = @{
  jsonrpc = '2.0'
  id      = 1
  method  = 'tools/call'
  params  = @{
    name      = 'create_inspection_report'
    arguments = @{
      report_type  = 'avfall'
      title        = 'Testrapport avfallsverksamhet'
      report_date  = '2026-09-08'
      report_text  = "# Allmant om tillsynen`nInspektion genomford som test.`n`n# Anmarkningar`n- Testanmarkning ett.`n- Testanmarkning tva."
      food_summary = @{ passed = ''; follow_up = ''; deviations = '' }
    }
  }
} | ConvertTo-Json -Depth 10

# Kontrollerar forst vilket schema servern faktiskt exponerar. Ar images inte med har,
# ar servern inte omdeployad - och da hjalper det inte att uppdatera prompten i Intric.
$listBody = @{ jsonrpc = '2.0'; id = 0; method = 'tools/list'; params = @{} } | ConvertTo-Json -Depth 5
try {
  $listed = Invoke-WebRequest -Uri $url -Method Post -Headers $headers -Body $listBody -UseBasicParsing
  $tool = ($listed.Content | ConvertFrom-Json).result.tools | Where-Object { $_.name -eq 'create_inspection_report' }
  $fields = $tool.inputSchema.properties.PSObject.Properties.Name
  Write-Host "`nServerns falt: $($fields -join ', ')" -ForegroundColor DarkGray
  if ($fields -contains 'images') { Write-Host "Bildstod ar utrullat pa servern." -ForegroundColor Green }
  else { Write-Host "Servern saknar annu faltet images - vanta pa Vercels bygge." -ForegroundColor Yellow }
}
catch { Write-Host "Kunde inte lasa verktygsschemat: $($_.Exception.Message)" -ForegroundColor Yellow }

Write-Host "`nAnropar $url ..." -ForegroundColor Cyan
try {
  $res = Invoke-WebRequest -Uri $url -Method Post -Headers $headers -Body $payload -UseBasicParsing
  Write-Host "HTTP $($res.StatusCode)" -ForegroundColor Green
  $body = $res.Content | ConvertFrom-Json

  if ($body.result.isError) {
    Write-Host "`nVERKTYGET RETURNERADE FEL:" -ForegroundColor Red
    $body.result.content | ForEach-Object { Write-Host $_.text }
  }
  else {
    $details = $body.result.structuredContent
    Write-Host "`nRAPPORT SKAPAD" -ForegroundColor Green
    Write-Host "  mall        : $($details.template_id)"
    Write-Host "  filnamn     : $($details.filename)"
    Write-Host "  standardmall: $($details.fallback_used)"
    Write-Host "  gar ut      : $($details.expires_at)"
    if ($details.warnings) { $details.warnings | ForEach-Object { Write-Host "  varning     : $_" -ForegroundColor Yellow } }
    Write-Host "`n  Ladda ner:" -ForegroundColor Cyan
    Write-Host "  $($details.download_url)"
  }
}
catch {
  Write-Host "ANROPET MISSLYCKADES" -ForegroundColor Red
  Write-Host $_.Exception.Message
  if ($_.Exception.Response) {
    $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
    Write-Host $reader.ReadToEnd()
  }
}
