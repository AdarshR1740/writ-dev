# Set up Writ on your own Supabase cloud project, then develop against it. Windows PowerShell.
#
#   powershell -ExecutionPolicy Bypass -File scripts\cloud-setup.ps1 <project-ref>
#
# The project ref is in your project's URL: https://supabase.com/dashboard/project/<project-ref>
# Safe to run again: it applies new migrations and redeploys the functions, and it
# keeps the existing encryption secret. Same steps as cloud-setup.sh.
#
# Needs: Node 18+. No Docker: functions are bundled on Supabase's servers (--use-api).
param([Parameter(Position = 0)][string]$Ref)
# Not "Stop": Windows PowerShell 5.1 treats any stderr output from npx (even npm
# warnings) as a terminating error under "Stop". Each step checks its exit code instead.
$ErrorActionPreference = "Continue"
Set-Location (Join-Path $PSScriptRoot "..")

if (-not $Ref) {
  Write-Host "Usage: powershell -ExecutionPolicy Bypass -File scripts\cloud-setup.ps1 <project-ref>"
  Write-Host "Find the ref in your project's dashboard URL: supabase.com/dashboard/project/<project-ref>"
  exit 1
}

function Supabase {
  & npx -y supabase@2 @args
  if ($LASTEXITCODE -ne 0) { throw "supabase $($args -join ' ') failed (exit $LASTEXITCODE). See the message above." }
}

Write-Host "1/5 Checking you're signed in to Supabase (the first run downloads the Supabase CLI; this can take a minute)..."
& npx -y supabase@2 projects list *> $null
if ($LASTEXITCODE -ne 0) {
  Write-Host ""
  Write-Host "    You're not signed in yet. When asked, press Enter to open the browser and sign in."
  Write-Host "    No browser? Stop with Ctrl+C, create a token at https://supabase.com/dashboard/account/tokens,"
  Write-Host "    run: npx -y supabase@2 login --token <your-token>   then run this script again."
  Write-Host ""
  Supabase login
}

Write-Host "2/5 Linking this folder to project $Ref..."
Supabase link --project-ref $Ref

Write-Host "3/5 Applying the database migrations..."
Supabase db push

Write-Host "4/5 Setting the key-encryption secret (once) and deploying the functions..."
$secrets = (& npx -y supabase@2 secrets list --project-ref $Ref 2>$null) -join "`n"
if ($secrets -match "KEY_ENCRYPTION_SECRET") {
  Write-Host "    KEY_ENCRYPTION_SECRET is already set; keeping it."
} else {
  # Never change this later: every saved AI key and WordPress password is encrypted with it.
  $secret = & node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64'))"
  Supabase secrets set --project-ref $Ref "KEY_ENCRYPTION_SECRET=$secret"
  Write-Host "    Set a new KEY_ENCRYPTION_SECRET on the project."
}
$functions = Get-ChildItem supabase\functions -Directory | Where-Object { $_.Name -notlike "_*" } | Sort-Object Name | ForEach-Object { $_.Name }
Supabase functions deploy @functions --project-ref $Ref --use-api

Write-Host "5/5 Pointing the web app at the project (web\.env.local, git-ignored)..."
$anon = $null
try {
  $keys = (& npx -y supabase@2 projects api-keys --project-ref $Ref -o json 2>$null) -join "" | ConvertFrom-Json
  $key = $keys | Where-Object { $_.name -eq "anon" } | Select-Object -First 1
  if (-not $key) { $key = $keys | Where-Object { $_.type -eq "publishable" } | Select-Object -First 1 }
  if ($key) { $anon = $key.api_key }
} catch { $anon = $null }
if ($anon) {
  # UTF-8 without a byte-order mark, so Vite reads the first line correctly.
  $content = "VITE_SUPABASE_URL=https://$Ref.supabase.co`nVITE_SUPABASE_ANON_KEY=$anon`n"
  [System.IO.File]::WriteAllText((Join-Path (Get-Location) "web\.env.local"), $content, (New-Object System.Text.UTF8Encoding $false))
  Write-Host "    Wrote web\.env.local."
} else {
  Write-Host "    Couldn't read the project's API key. Copy web\.env.example to web\.env.local and fill in"
  Write-Host "    the project URL and anon (public) key from Project Settings -> API."
}

if (-not (Test-Path "web\node_modules")) {
  Push-Location web
  & npm install
  Pop-Location
}

Write-Host ""
Write-Host "Done. Two settings to check once in the Supabase dashboard (Authentication -> URL Configuration):"
Write-Host "  - Site URL: http://localhost:5173 (your real address once you deploy the web app)"
Write-Host "  - Redirect URLs: add http://localhost:5173/**"
Write-Host "New accounts get a confirmation email on the cloud project; that's what these settings are for."
Write-Host ""
Write-Host "Start developing:"
Write-Host "  cd web; npm run dev"
Write-Host "Then open http://localhost:5173."
