# Run the app locally: http://localhost:8787 (customer) / http://localhost:8787/admin.html (admin)
# The Anthropic API key is read from the Windows user environment (setx ANTHROPIC_API_KEY ...).
# The admin password for local use is in .dev.vars.
Set-Location $PSScriptRoot
# Prefer the saved user setting (setx) over the inherited environment:
# programs started before a setx still carry the old key.
$saved = (Get-ItemProperty HKCU:\Environment -ErrorAction SilentlyContinue).ANTHROPIC_API_KEY
if ($saved) { $env:ANTHROPIC_API_KEY = $saved }
if (-not $env:ANTHROPIC_API_KEY) { Write-Host "ANTHROPIC_API_KEY is not set. Run: setx ANTHROPIC_API_KEY <key>"; exit 1 }
# The local Worker reads secrets from .dev.vars (git-ignored, this PC only).
# Keep the other lines and refresh the API key line from the user environment every run.
$lines = @()
# @(...) keeps this a list even when the file has only one line (otherwise += would glue text together)
if (Test-Path .dev.vars) { $lines = @(Get-Content .dev.vars | Where-Object { $_ -and $_ -notlike 'ANTHROPIC_API_KEY=*' }) }
$lines += "ANTHROPIC_API_KEY=$($env:ANTHROPIC_API_KEY)"
$lines | Out-File .dev.vars -Encoding ascii
# Create the local database tables (safe to run every time)
wrangler d1 execute fixdesk-db --local --file schema.sql | Out-Null
wrangler dev --port 8787
