<#
  dsh 凭据录入台（mcp-browser）—— 双击同目录 vault.cmd 即可用。

  为什么有它：vault.mjs 是给命令行用的一串参数；主人平时要的是「打开就能填」。
  本脚本只做菜单与转调，读写一律交给 vault.mjs —— 账密由它自己处理，
  本脚本**不读、不打印、不缓存**任何账密，输出里只有「有没有账号/密码/选择器」。

  存盘约定：UTF-8 带 BOM（Windows PowerShell 5.1 读无 BOM 的中文会乱码并解析失败）。
  对应的 .cmd 包装器保持纯 ASCII（cmd 按 ANSI 读文件）。

  两条实测踩坑（2026-09-24）：
  ① `(Read-Host '选择').Trim()` 在输入耗尽（EOF）时会在 $null 上抛错，错误被 Continue 吞掉后
     菜单空转成死循环 → 现统一走 Read-Line，$null 即退出。
  ② 中文输入法下数字键常出**全角**（１），直接与 '1' 比较会全部落空；又因为每轮 Clear-Host，
     「没这个选项」一闪就没，表现成「输入数字回车毫无反应」→ 现做全角→半角归一化，
     并把收到的原文回显出来，且不再每轮清屏。
#>
$ErrorActionPreference = 'Continue'
$here = $PSScriptRoot
$vaultJs = Join-Path $here 'vault.mjs'
$node = 'node'

if (-not (Test-Path $vaultJs)) {
  Write-Host ("找不到 vault.mjs：{0}" -f $vaultJs) -ForegroundColor Red
  Read-Host '回车关闭'
  exit 1
}

# 读一行并 trim；输入耗尽（EOF）返回 $null —— 调用方一律据此退出。
function Read-Line([string]$prompt) {
  $v = Read-Host $prompt
  if ($null -eq $v) { return $null }
  return ([string]$v).Trim()
}

# 全角 → 半角（中文输入法下 ０-９ / Ａ-Ｚ / ａ-ｚ / 全角空格 都会出现）。
function ConvertTo-HalfWidth([string]$s) {
  if ($null -eq $s) { return $null }
  $sb = New-Object System.Text.StringBuilder
  foreach ($ch in $s.ToCharArray()) {
    $code = [int][char]$ch
    if ($code -ge 0xFF10 -and $code -le 0xFF19) { [void]$sb.Append([char]($code - 0xFF10 + 0x30)) }
    elseif ($code -ge 0xFF21 -and $code -le 0xFF3A) { [void]$sb.Append([char]($code - 0xFF21 + 0x41)) }
    elseif ($code -ge 0xFF41 -and $code -le 0xFF5A) { [void]$sb.Append([char]($code - 0xFF41 + 0x61)) }
    elseif ($code -eq 0x3000) { [void]$sb.Append(' ') }
    else { [void]$sb.Append($ch) }
  }
  return $sb.ToString().Trim()
}

# 读一个菜单序号：返回归一化后的串；EOF 返回 $null。
function Read-Choice {
  $raw = Read-Line '请输入序号 (0-5)'
  if ($null -eq $raw) { return $null }
  $norm = ConvertTo-HalfWidth $raw
  if ($norm -ne $raw) { Write-Host ("  （已把输入 '{0}' 归一化为 '{1}'）" -f $raw, $norm) -ForegroundColor DarkGray }
  return $norm
}

function Show-Menu {
  $vp = (& $node $vaultJs path) 2>$null | Select-Object -First 1
  if (-not $vp) { $vp = '(读不到库路径)' }
  $secDir = Split-Path $vp -Parent
  $inputFile = Join-Path $secDir 'sites.input.ini'
  $state = '尚未生成'
  if (Test-Path $inputFile) { $state = '已存在（可继续填）' }
  Write-Host ''
  Write-Host '============ dsh 凭据录入台（mcp-browser）============' -ForegroundColor Cyan
  Write-Host ("  凭据库 : {0}" -f $vp)
  Write-Host ("  录入表 : {0}   [{1}]" -f $inputFile, $state)
  Write-Host '-----------------------------------------------------'
  Write-Host '  1) 生成 / 打开录入表（记事本里填站点与账密）'
  Write-Host '  2) 导入录入表（先干跑给你看；成功即删表）'
  Write-Host '  3) 查看已配置站点（只报有没有账号/密码/选择器）'
  Write-Host '  4) 删除某个站点'
  Write-Host '  5) 打开凭据库所在文件夹'
  Write-Host '  0) 退出'
  Write-Host ''
  return [pscustomobject]@{ Vault = $vp; Dir = $secDir; Input = $inputFile }
}

if (-not [Console]::IsInputRedirected) { Clear-Host }
Write-Host '提示：若敲键没反应，先用鼠标点一下本窗口（让键盘焦点落在这里）。' -ForegroundColor DarkGray

while ($true) {
  $ctx = Show-Menu
  $choice = Read-Choice
  if ($null -eq $choice) { Write-Host ''; Write-Host '（输入结束，退出）'; return }
  $inputFile = $ctx.Input

  if ($choice -eq '') { continue }
  elseif ($choice -eq '0' -or $choice -match '^(q|quit|exit)$') { return }

  elseif ($choice -eq '1') {
    if (-not (Test-Path $inputFile)) { & $node $vaultJs template; Write-Host '' }
    else { Write-Host ("录入表已存在，直接打开：{0}" -f $inputFile) -ForegroundColor Green }
    $open = Read-Line '用记事本打开它？[y/N]'
    if ($null -eq $open) { return }
    if ($open -match '^(y|Y|是)$') {
      Start-Process -FilePath 'notepad.exe' -ArgumentList ('"' + $inputFile + '"')
      Write-Host '填完保存即可；回到本窗口选 2 导入（表里示例要先把行首的 # 去掉）。' -ForegroundColor Yellow
    }
    if ($null -eq (Read-Line '回车继续')) { return }
  }

  elseif ($choice -eq '2') {
    if (-not (Test-Path $inputFile)) {
      Write-Host '还没有录入表 —— 先选 1 生成并填写。' -ForegroundColor Yellow
      if ($null -eq (Read-Line '回车继续')) { return }
    } else {
      Write-Host '--- 干跑（只看解析结果，不写入凭据库）---' -ForegroundColor Cyan
      & $node $vaultJs import $inputFile --dry-run
      if ($LASTEXITCODE -ne 0) {
        Write-Host '解析没过：按上面的提示改录入表（示例块要取消注释）。' -ForegroundColor Red
        if ($null -eq (Read-Line '回车继续')) { return }
      } else {
        $ok = Read-Line '确认导入？导入成功后录入表会被删除 [y/N]'
        if ($null -eq $ok) { return }
        if ($ok -match '^(y|Y|是)$') { & $node $vaultJs import $inputFile }
        else { Write-Host '已取消，录入表保留。' -ForegroundColor Yellow }
        if ($null -eq (Read-Line '回车继续')) { return }
      }
    }
  }

  elseif ($choice -eq '3') {
    & $node $vaultJs list
    if ($null -eq (Read-Line '回车继续')) { return }
  }

  elseif ($choice -eq '4') {
    $key = Read-Line '要删除的站点 key（先选 3 看列表；直接回车=取消）'
    if ($null -eq $key) { return }
    if ($key.Length -gt 0) {
      $ok = Read-Line ("确认删除 {0}？[y/N]" -f $key)
      if ($null -eq $ok) { return }
      if ($ok -match '^(y|Y|是)$') { & $node $vaultJs rm $key }
      else { Write-Host '已取消。' -ForegroundColor Yellow }
    }
    if ($null -eq (Read-Line '回车继续')) { return }
  }

  elseif ($choice -eq '5') {
    Start-Process -FilePath 'explorer.exe' -ArgumentList ('"' + $ctx.Dir + '"')
  }

  else {
    Write-Host ("没这个选项：「{0}」—— 请输入 0 到 5 的数字（全角也算）。" -f $choice) -ForegroundColor Yellow
    Start-Sleep -Milliseconds 1200
  }
}
