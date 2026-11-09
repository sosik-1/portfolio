# 처음 한 번 (또는 워크플로를 고친 뒤): 상담 대장 파일 만들기 → 워크플로 불러오기 → 켜기
# n8n이 꺼져 있을 때 실행하세요.
Set-Location $PSScriptRoot
. .\n8n-env.ps1
New-Item -ItemType Directory -Force records | Out-Null
$ledger = "records\상담대장.csv"
if (-not (Test-Path $ledger)) {
  $head = '"접수번호","접수시각","채널","이름","연락처","시술","문의 종류","급한 정도","담당 부서","광고 주의","빠진 정보","요약","가린 문의 내용","답변 초안","상태","비고","문의 원문","가린 정보"'
  [IO.File]::WriteAllText((Join-Path $PSScriptRoot $ledger), "$head`r`n", (New-Object Text.UTF8Encoding $true))
}
node workflow/build.mjs
node $N8N import:workflow --input=workflow/clinic-inbox.workflow.json
node $N8N publish:workflow --id=ClinicInbox000001
