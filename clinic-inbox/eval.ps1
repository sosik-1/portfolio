# 정답 시험 실행: .\eval.ps1   (1회 약 500원)
Set-Location $PSScriptRoot
$saved = (Get-ItemProperty HKCU:\Environment -ErrorAction SilentlyContinue).ANTHROPIC_API_KEY
if ($saved) { $env:ANTHROPIC_API_KEY = $saved }
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
node eval/run.mjs @args
