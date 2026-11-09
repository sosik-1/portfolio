# Register the expense agent's secrets (run this yourself).
#  1) ANTHROPIC_API_KEY: taken from your saved user setting (setx), never printed
#  2) SHEET_WEBHOOK_URL: the Google Apps Script web app URL (see apps_script.gs)  - press Enter on an empty line to skip
#  3) SHEET_SECRET: the same value you put in the Apps Script property SECRET
Set-Location $PSScriptRoot
$key = (Get-ItemProperty HKCU:\Environment -ErrorAction SilentlyContinue).ANTHROPIC_API_KEY
if (-not $key) { Write-Host "ANTHROPIC_API_KEY is not saved. Run: setx ANTHROPIC_API_KEY <key>"; exit 1 }
# Pipe text without a BOM (an invisible character that broke the key once)
$OutputEncoding = New-Object System.Text.UTF8Encoding $false
$key = $key.Trim().Trim([char]0xFEFF)
Write-Host "[1/3] Uploading ANTHROPIC_API_KEY ..."
$key | npx wrangler secret put ANTHROPIC_API_KEY
$url = Read-Host "[2/3] Google Apps Script web app URL (Enter to skip)"
if ($url) {
  $url.Trim() | npx wrangler secret put SHEET_WEBHOOK_URL
  $sec = Read-Host "[3/3] SECRET value from Apps Script properties"
  $sec.Trim() | npx wrangler secret put SHEET_SECRET
}
Write-Host "Done. Open https://expense-agent.dlalsrn08011.workers.dev"
