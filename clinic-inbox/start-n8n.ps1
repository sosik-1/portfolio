# n8n 켜기: 편집 화면 http://localhost:5680
#   문의 받기:      POST http://localhost:5680/webhook/clinic-inquiry
#   상담실장 화면:  http://localhost:5680/webhook/clinic-board
Set-Location $PSScriptRoot
. .\n8n-env.ps1
node $N8N start
