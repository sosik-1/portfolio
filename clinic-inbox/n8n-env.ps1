# n8n 실행 설정 (start-n8n.ps1, setup-n8n.ps1이 같이 씀)
# - n8n 데이터는 이 폴더(.n8n)에, n8n 프로그램은 n8n-report 폴더 것을 같이 써요
# - API 키·Slack 주소는 Windows 사용자 환경변수(setx)에서 읽어서 n8n에 직접 적지 않아요
$script:N8N = "C:\dev\n8n-report\node_modules\n8n\bin\n8n"
$reg = Get-ItemProperty HKCU:\Environment -ErrorAction SilentlyContinue
if ($reg.ANTHROPIC_API_KEY) { $env:ANTHROPIC_API_KEY = $reg.ANTHROPIC_API_KEY }
if ($reg.CLINIC_ALERT_WEBHOOK_URL) { $env:ALERT_WEBHOOK_URL = $reg.CLINIC_ALERT_WEBHOOK_URL }
$env:N8N_USER_FOLDER = $PSScriptRoot
$env:N8N_BLOCK_ENV_ACCESS_IN_NODE = "false"
$env:N8N_RESTRICT_FILE_ACCESS_TO = "$PSScriptRoot\records"
$env:N8N_DIAGNOSTICS_ENABLED = "false"
$env:N8N_VERSION_NOTIFICATIONS_ENABLED = "false"
$env:N8N_PERSONALIZATION_ENABLED = "false"
$env:EXECUTIONS_DATA_SAVE_ON_SUCCESS = "none"
$env:EXECUTIONS_DATA_SAVE_ON_ERROR = "none"
$env:EXECUTIONS_DATA_SAVE_MANUAL_EXECUTIONS = "false"
# 저장 안 하는 실행도 n8n은 "지움 표시"만 하고 한동안 남겨 둬요. 정리 기능을 끄면 끝나자마자 바로 지워요.
$env:EXECUTIONS_DATA_PRUNE = "false"
$env:GENERIC_TIMEZONE = "Asia/Seoul"
$env:TZ = "Asia/Seoul"
$env:N8N_PORT = "5680"
$env:N8N_RUNNERS_BROKER_PORT = "5681"
