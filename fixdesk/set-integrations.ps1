# Register the integration secrets for fixdesk (run this yourself).
# Each value is typed into wrangler's hidden prompt, so it never shows on screen or in chat.
#  1) SLACK_WEBHOOK_URL  : Slack Incoming Webhook for the #하자-접수 channel
#  2) SHEET_WEBHOOK_URL  : the same Google Apps Script web app URL the expense agent uses
#  3) SHEET_SECRET       : the same SECRET value from the Apps Script properties
#  4) NOTION_TOKEN       : Notion integration "Internal Integration Secret" (starts with ntn_)
#  5) NOTION_DB_ID       : the Notion database link (paste the whole link, the code finds the id)
# Only one item:  .\set-integrations.ps1 SLACK_WEBHOOK_URL
Set-Location $PSScriptRoot
$all = "SLACK_WEBHOOK_URL", "SHEET_WEBHOOK_URL", "SHEET_SECRET", "NOTION_TOKEN", "NOTION_DB_ID"
$names = if ($args.Count) { $args } else { $all }
foreach ($name in $names) {
  if ($args.Count) { npx wrangler secret put $name; continue }
  while ($true) {
    Write-Host ""
    $ans = Read-Host "Set $name now? Type y then Enter (just Enter = skip). Do NOT paste the value here"
    if ($ans.Length -gt 3) {
      # The value was pasted into the wrong place: it is now visible on screen, so warn and ask again
      Write-Host "  That looks like the value itself. It was NOT saved. Type only y, then paste the value at the hidden prompt." -ForegroundColor Yellow
      continue
    }
    break
  }
  if ($ans -eq "y") { npx wrangler secret put $name }
}
Write-Host "Done."
