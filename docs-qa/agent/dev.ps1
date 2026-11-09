# Run the agent locally: http://localhost:8790  (needs docs-qa running on :8788 for rule search)
Set-Location $PSScriptRoot
$saved = (Get-ItemProperty HKCU:\Environment -ErrorAction SilentlyContinue).ANTHROPIC_API_KEY
if ($saved) { $env:ANTHROPIC_API_KEY = $saved }
if (-not $env:ANTHROPIC_API_KEY) { Write-Host "ANTHROPIC_API_KEY is not set. Run: setx ANTHROPIC_API_KEY <key>"; exit 1 }
$lines = @()
if (Test-Path .dev.vars) { $lines = @(Get-Content .dev.vars | Where-Object { $_ -and $_ -notlike 'ANTHROPIC_API_KEY=*' }) }
if (-not ($lines | Where-Object { $_ -like 'ADMIN_TOKEN=*' })) { $lines += "ADMIN_TOKEN=$([guid]::NewGuid().ToString('N'))" }
if (-not ($lines | Where-Object { $_ -like 'DOCS_QA_URL=*' })) { $lines += "DOCS_QA_URL=http://localhost:8788" }
$lines += "ANTHROPIC_API_KEY=$($env:ANTHROPIC_API_KEY)"
$lines | Out-File .dev.vars -Encoding ascii
npx wrangler d1 execute docs-qa-db --local --file schema.sql | Out-Null
uv run pywrangler dev --port 8790
