# Register the deployed Worker's secrets (run this yourself once).
#  1) ANTHROPIC_API_KEY: taken from your saved user setting (setx), never printed
#  2) ADMIN_PASSWORD: operator password, full access (choose your own, keep it private)
#  3) DEMO_PASSWORD: demo password for interviewers, view-only, names/phones masked
#  4) WEBHOOK_URL (optional): run "wrangler secret put WEBHOOK_URL" later if you want Discord alerts
Set-Location $PSScriptRoot
$key = (Get-ItemProperty HKCU:\Environment -ErrorAction SilentlyContinue).ANTHROPIC_API_KEY
if (-not $key) { Write-Host "ANTHROPIC_API_KEY is not saved. Run: setx ANTHROPIC_API_KEY <key>"; exit 1 }
Write-Host "[1/3] Uploading ANTHROPIC_API_KEY ..."
$key | wrangler secret put ANTHROPIC_API_KEY
Write-Host ""
Write-Host "[2/3] OPERATOR password (full access). Type it, then press Enter:"
wrangler secret put ADMIN_PASSWORD
Write-Host ""
Write-Host "[3/3] DEMO password (view-only, for interviewers). Type a DIFFERENT one, then press Enter:"
wrangler secret put DEMO_PASSWORD
Write-Host ""
Write-Host "Done. Open https://fixdesk.dlalsrn08011.workers.dev"
