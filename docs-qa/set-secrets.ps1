# Register the deployed Worker's API key (run this yourself once).
# ANTHROPIC_API_KEY is taken from your saved user setting (setx) and never printed.
# (ADMIN_TOKEN for loading sample docs is already set; its value is in .dev.vars as PROD_ADMIN_TOKEN.)
Set-Location $PSScriptRoot
$key = (Get-ItemProperty HKCU:\Environment -ErrorAction SilentlyContinue).ANTHROPIC_API_KEY
if (-not $key) { Write-Host "ANTHROPIC_API_KEY is not saved. Run: setx ANTHROPIC_API_KEY <key>"; exit 1 }
# Pipe text without a BOM (an invisible character that broke the key once)
$OutputEncoding = New-Object System.Text.UTF8Encoding $false
$key = $key.Trim().Trim([char]0xFEFF)
Write-Host "Uploading ANTHROPIC_API_KEY ..."
$key | wrangler secret put ANTHROPIC_API_KEY
Write-Host ""
Write-Host "Done. Open https://docs-qa.dlalsrn08011.workers.dev"
