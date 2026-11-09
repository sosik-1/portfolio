# Register the Slack webhook for the expense agent (#경비-검수 channel). Run this yourself.
# Type the URL into wrangler's hidden prompt, so it never shows on screen or in chat.
Set-Location $PSScriptRoot
npx wrangler secret put SLACK_WEBHOOK_URL
Write-Host "Done."
