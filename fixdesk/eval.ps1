# Run the accuracy evaluation: .\eval.ps1        (all cases)
#                              .\eval.ps1 1 2 33 (selected case ids)
Set-Location $PSScriptRoot
# Prefer the saved user setting (setx) over the inherited environment:
# programs started before a setx still carry the old key.
$saved = (Get-ItemProperty HKCU:\Environment -ErrorAction SilentlyContinue).ANTHROPIC_API_KEY
if ($saved) { $env:ANTHROPIC_API_KEY = $saved }
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
node eval/run.mjs @args
