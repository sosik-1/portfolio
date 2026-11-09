# Start n8n for the "site diagnosis -> AI report" demo: http://localhost:5678
# - n8n data (workflows, settings) lives in this folder (.n8n), not in your user profile
# - The Anthropic API key is read from your saved user setting (setx) and passed as an environment variable,
#   so it never has to be typed into n8n
Set-Location $PSScriptRoot
$saved = (Get-ItemProperty HKCU:\Environment -ErrorAction SilentlyContinue).ANTHROPIC_API_KEY
if ($saved) { $env:ANTHROPIC_API_KEY = $saved }
$env:N8N_USER_FOLDER = $PSScriptRoot
$env:N8N_BLOCK_ENV_ACCESS_IN_NODE = "false"          # lets the workflow read $env.ANTHROPIC_API_KEY
$env:N8N_RESTRICT_FILE_ACCESS_TO = "$PSScriptRoot\reports"   # the workflow may only write inside reports\
$env:N8N_DIAGNOSTICS_ENABLED = "false"
$env:N8N_VERSION_NOTIFICATIONS_ENABLED = "false"
$env:N8N_PERSONALIZATION_ENABLED = "false"
$env:GENERIC_TIMEZONE = "Asia/Seoul"
$env:TZ = "Asia/Seoul"
$env:N8N_PORT = "5678"
npx n8n start
