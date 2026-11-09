# Re-set the operator and demo passwords on the deployed Worker.
# The two must be different: if they are the same, the server always treats you as the operator.
# Typed values are hidden and only sent to Cloudflare.
Set-Location $PSScriptRoot

function Read-Plain($prompt) {
  $s = Read-Host -Prompt $prompt -AsSecureString
  $p = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($p) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($p) }
}

while ($true) {
  $admin = Read-Plain "OPERATOR password (full access, keep private)"
  $demo  = Read-Plain "DEMO password (view-only, for interviewers)"
  if ($admin.Length -lt 6 -or $demo.Length -lt 6) { Write-Host "Use at least 6 characters. Try again.`n"; continue }
  if ($admin -ceq $demo) { Write-Host "The two passwords are the same. Please choose different ones.`n"; continue }
  $again = Read-Plain "Type the DEMO password once more to confirm"
  if ($again -cne $demo) { Write-Host "Demo password did not match. Try again.`n"; continue }
  break
}

Write-Host "`nSaving operator password ..."
$admin | wrangler secret put ADMIN_PASSWORD
Write-Host "`nSaving demo password ..."
$demo | wrangler secret put DEMO_PASSWORD
$admin = $null; $demo = $null; $again = $null
Write-Host "`nDone. Log in again at https://fixdesk.dlalsrn08011.workers.dev/admin.html"
