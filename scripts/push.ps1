# 推送到 GitHub。
# 有些电脑上 git 的凭据助手不能正常工作，git push 无法自动登录。
# 这个脚本每次从 gh 取当前登录的令牌，只放在这一次推送的请求头里，不打印、不写进任何配置或文件。
# 用法（在项目文件夹里）：
#   powershell -ExecutionPolicy Bypass -File scripts\push.ps1            # 推送当前分支
#   powershell -ExecutionPolicy Bypass -File scripts\push.ps1 --dry-run  # 只检查不推送
# 也可以直接双击项目根目录的 push.cmd。

$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)

$gh = (Get-Command gh -ErrorAction SilentlyContinue).Source
if (-not $gh) { Write-Host '没有找到 GitHub CLI（gh），请先安装并运行 gh auth login'; exit 1 }
$tok = (& $gh auth token 2>$null)
if (-not $tok) { Write-Host 'gh 还没有登录，请先运行 gh auth login'; exit 1 }

$b64 = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes('x-access-token:' + $tok.Trim()))
Remove-Variable tok
$env:GIT_TERMINAL_PROMPT = '0'
$branch = (git rev-parse --abbrev-ref HEAD).Trim()

$ErrorActionPreference = 'Continue'
git -c credential.helper= -c "http.https://github.com/.extraheader=AUTHORIZATION: basic $b64" push -u origin $branch @args 2>&1 |
  ForEach-Object { ("$_" -replace [regex]::Escape($b64), '***') }
$code = $LASTEXITCODE
Remove-Variable b64

$dry = $args -contains '--dry-run' -or $args -contains '-n'
if ($code -ne 0) { Write-Host "推送失败（git 返回 $code）" }
elseif ($dry) { Write-Host "检查通过：可以推送 $branch（这次没有真正推送）" }
else { Write-Host "已推送 $branch 到 GitHub" }
exit $code
