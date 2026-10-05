# ============================================================
#  VencForge 1.0 - свой менеджер Vencord
#  Сборка Vencord из исходников с плагинами из Git + патч Discord
#  и Vesktop. Плагины выживают любые обновления: при каждом
#  запуске VencForge тянет свежий Vencord и свежие плагины и
#  пересобирает всё заново.
#
#  Режимы (VencForge.bat <режим> или меню):
#    install    - обновить репозитории, собрать, пропатчить Discord (+Vesktop)
#    update     - то же, но без вопросов (для планировщика задач)
#    repair     - перепатчить Discord текущей сборкой (после обновления Discord)
#    build-only - только обновить и пересобрать (не трогать Discord)
#    uninstall  - вернуть Discord к оригиналу, отвязать Vesktop
#    schedule   - автообновление по расписанию (каждые 6 часов)
#    deschedule - убрать задачу расписания
#    doctor     - диагностика для поддержки
#    menu       - интерактивное меню (по умолчанию)
# ============================================================

$script:VfVersion = '1.0.0'
$script:Mode = if ($env:VENCFORGE_MODE) { $env:VENCFORGE_MODE } else { 'menu' }

$AppData   = [Environment]::GetFolderPath('ApplicationData')
$LocalData = [Environment]::GetFolderPath('LocalApplicationData')
$Root      = Join-Path $AppData 'VencForge'
$Workspace = Join-Path $Root 'workspace'
$PluginsDir= Join-Path $Workspace 'plugins'
$VcDir     = Join-Path $Workspace 'Vencord'
$DistDir   = Join-Path $Root 'dist'
$LogDir    = Join-Path $Root 'logs'
$LogFile   = Join-Path $LogDir 'vencforge.log'
$ConfigFile= Join-Path $Root 'config.json'
$StateFile = Join-Path $Root 'state.json'
$BatPathFile = Join-Path $Root 'install.txt'

foreach ($d in @($Root, $Workspace, $PluginsDir, $LogDir)) {
    if (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
}

function Write-Log([string]$m) {
    try {
        $stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
        Add-Content -Path $LogFile -Value "[$stamp] $m" -Encoding UTF8
    } catch { }
}
function Ok([string]$m)   { Write-Host ('  [+] ' + $m) -ForegroundColor Green;  Write-Log "OK  $m" }
function Warn([string]$m) { Write-Host ('  [!] ' + $m) -ForegroundColor Yellow; Write-Log "WRN $m" }
function Err([string]$m)  { Write-Host ('  [X] ' + $m) -ForegroundColor Red;    Write-Log "ERR $m" }
function Info([string]$m) { Write-Host ('  [i] ' + $m) -ForegroundColor Cyan;   Write-Log "INF $m" }

function Read-YesNo([string]$question, [bool]$defaultYes = $true) {
    $hint = if ($defaultYes) { '[Enter = да / n = нет]' } else { '[y = да / Enter = нет]' }
    $ans = Read-Host "  $question $hint"
    if ($ans -match '^(n|no|нет|н)$') { return $false }
    if ($ans -match '^(y|yes|да|д)$') { return $true }
    return $defaultYes
}

# ---------------------------------------------------------------- JSON без BOM
function Write-JsonNoBom([string]$path, [string]$json) {
    $enc = New-Object System.Text.UTF8Encoding($false)
    [IO.File]::WriteAllText($path, $json, $enc)
}

# ---------------------------------------------------------------- конфиг
$script:Config = $null
function Load-Config {
    if (-not (Test-Path $ConfigFile)) {
        $cfg = @{
            vencordRepo   = 'https://github.com/Vendicated/Vencord'
            vencordBranch = 'main'
            plugins       = @(
                @{ name = 'P2PStream'; url = 'https://github.com/shxtai/P2PStream' }
            )
        }
        Write-JsonNoBom $ConfigFile ($cfg | ConvertTo-Json -Depth 10)
    }
    $raw = [IO.File]::ReadAllText($ConfigFile)
    $script:Config = $raw | ConvertFrom-Json
    if (-not $script:Config) { throw 'config.json не прочитался' }
}

# ---------------------------------------------------------------- зависимости
function Test-Command([string]$name) {
    return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

function Test-NodeOk {
    if (-not (Test-Command 'node')) { return $false }
    try {
        $ver = ((& node -v) -join '') -replace '^v',''
        $major = [int]($ver.Split('.')[0])
        return ($major -ge 18)
    } catch { return $false }
}

function Test-Prereq([bool]$interactive) {
    $needGit = -not (Test-Command 'git')
    $needNode = -not (Test-NodeOk)
    if (-not $needGit -and -not $needNode) {
        Ok 'git и node на месте'
        return $true
    }
    $missing = @()
    if ($needGit) { $missing += 'git' }
    if ($needNode) { $missing += 'node (LTS, 18+)' }
    Warn ('Не хватает: ' + ($missing -join ', '))
    if (-not (Test-Command 'winget')) {
        Err 'winget не найден. Установи вручную: git-scm.com и nodejs.org (LTS), затем запусти VencForge снова.'
        return $false
    }
    if (-not $interactive) {
        Err 'Авто-режим: зависимости не установлены, продолжение невозможно.'
        return $false
    }
    if (-not (Read-YesNo 'Установить недостающее через winget (Git и/или Node LTS)?' $true)) { return $false }
    if ($needGit) {
        Info 'Ставлю Git (может запросить права администратора)...'
        try {
            Start-Process winget -ArgumentList 'install','-e','--id','Git.Git','--accept-source-agreements','--accept-package-agreements' -Verb RunAs -Wait
        } catch { Warn ('winget git: ' + $_.Exception.Message) }
    }
    if ($needNode) {
        Info 'Ставлю Node.js LTS (может запросить права администратора)...'
        try {
            Start-Process winget -ArgumentList 'install','-e','--id','OpenJS.NodeJS.LTS','--accept-source-agreements','--accept-package-agreements' -Verb RunAs -Wait
        } catch { Warn ('winget node: ' + $_.Exception.Message) }
    }
    if (-not (Test-Command 'git') -or -not (Test-NodeOk)) {
        Warn 'Если установка прошла успешно - просто закрой окно и запусти VencForge заново (нужен свежий PATH).'
        return $false
    }
    Ok 'git и node на месте'
    return $true
}

# ---------------------------------------------------------------- git
function Update-GitRepo([string]$url, [string]$dir, [string]$branch) {
    if (Test-Path (Join-Path $dir '.git')) {
        try {
            $before = (& git -C $dir rev-parse HEAD) 2>$null
            & git -C $dir remote set-url origin $url 2>$null
            & git -C $dir fetch --depth 1 origin $branch 2>$null | Out-Null
            if ($LASTEXITCODE -ne 0) { return @{ ok = $false; changed = $false } }
            & git -C $dir reset --hard FETCH_HEAD 2>$null | Out-Null
            & git -C $dir clean -fd 2>$null | Out-Null
            if ($LASTEXITCODE -ne 0) { return @{ ok = $false; changed = $false } }
            $after = (& git -C $dir rev-parse HEAD) 2>$null
            return @{ ok = $true; changed = ("$before" -ne "$after") }
        } catch {
            return @{ ok = $false; changed = $false }
        }
    } else {
        if (Test-Path $dir) { Remove-Item -Recurse -Force $dir }
        & git clone --depth 1 --branch $branch $url $dir 2>$null | Out-Null
        if ($LASTEXITCODE -ne 0) { return @{ ok = $false; changed = $false } }
        return @{ ok = $true; changed = $true }
    }
}

# ---------------------------------------------------------------- plugins -> userplugins
function Find-PluginRoot([string]$repoDir) {
    foreach ($ext in @('index.tsx','index.ts','index.jsx','index.js')) {
        if (Test-Path (Join-Path $repoDir $ext)) { return $repoDir }
    }
    $hits = @()
    $subs = Get-ChildItem -Path $repoDir -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -ne '.git' }
    foreach ($s in $subs) {
        foreach ($ext in @('index.tsx','index.ts','index.jsx','index.js')) {
            if (Test-Path (Join-Path $s.FullName $ext)) { $hits += $s.FullName; break }
        }
    }
    if ($hits.Count -eq 1) { return $hits[0] }
    return $null
}

function Sync-Plugins {
    $up = Join-Path $VcDir 'src\userplugins'
    if (-not (Test-Path $up)) { New-Item -ItemType Directory -Path $up -Force | Out-Null }
    foreach ($p in $Config.plugins) {
        $repo = Join-Path $PluginsDir $p.name
        if (-not (Test-Path $repo)) { Warn ('Плагин ' + $p.name + ' не скачан - пропускаю'); continue }
        $src = Find-PluginRoot $repo
        if (-not $src) {
            Warn ('В репозитории ' + $p.name + ' не найден index.ts/tsx - пропускаю')
            continue
        }
        $dest = Join-Path $up $p.name
        if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
        Copy-Item -Recurse -Force $src $dest
        if (Test-Path (Join-Path $dest '.git')) { Remove-Item -Recurse -Force (Join-Path $dest '.git') }
        Ok ('Плагин ' + $p.name + ' подключён к сборке')
    }
    return $true
}

# ---------------------------------------------------------------- сборка
function Build-Vencord {
    Info 'Устанавливаю зависимости Vencord (pnpm install)...'
    Push-Location $VcDir
    try {
        & corepack pnpm install --frozen-lockfile 2>&1 | ForEach-Object { Write-Host ('    | ' + $_) -ForegroundColor DarkGray }
        if ($LASTEXITCODE -ne 0) { Err 'pnpm install не удался'; return $false }
        Info 'Собираю Vencord (pnpm build)...'
        & corepack pnpm build 2>&1 | Select-Object -Last 5 | ForEach-Object { Write-Host ('    | ' + $_) -ForegroundColor DarkGray }
        if ($LASTEXITCODE -ne 0) { Err 'pnpm build не удался'; return $false }
    } finally {
        Pop-Location
    }
    $mainJs = Join-Path $VcDir 'dist\vencordDesktopMain.js'
    $patcher = Join-Path $VcDir 'dist\patcher.js'
    if (-not (Test-Path $mainJs) -or -not (Test-Path $patcher)) {
        Err 'В dist нет ожидаемых файлов (patcher.js / vencordDesktopMain.js)'
        return $false
    }
    if (Test-Path $DistDir) { Remove-Item -Recurse -Force $DistDir }
    New-Item -ItemType Directory -Path $DistDir -Force | Out-Null
    Copy-Item -Path (Join-Path $VcDir 'dist\*') -Destination $DistDir -Recurse -Force
    Get-ChildItem $DistDir -Filter '*.map' -ErrorAction SilentlyContinue | Remove-Item -Force
    Write-JsonNoBom (Join-Path $DistDir 'package.json') '{}'
    Ok ('Сборка готова: ' + $DistDir)
    return $true
}

# ---------------------------------------------------------------- Discord: поиск и патч
function Find-DiscordInstalls {
    $list = @()
    $branches = @('Discord','DiscordPTB','DiscordCanary','DiscordDevelopment')
    foreach ($b in $branches) {
        $base = Join-Path $LocalData $b
        if (-not (Test-Path $base)) { continue }
        $apps = Get-ChildItem -Path $base -Directory -Filter 'app-*' -ErrorAction SilentlyContinue | Sort-Object Name -Descending
        foreach ($app in $apps) {
            $res = Join-Path $app.FullName 'resources'
            if (-not (Test-Path $res)) { continue }
            if ((Test-Path (Join-Path $res 'app.asar')) -or (Test-Path (Join-Path $res '_app.asar'))) {
                $list += @{ Branch = $b; Resources = $res }
            }
        }
    }
    return ,$list
}

function New-VencordAsar([string]$patcherPath, [string]$outFile) {
    $esc = $patcherPath.Replace('\','\\').Replace('"','\"')
    $idx = 'require("' + $esc + '")'
    $pkg = '{"name":"discord","main":"index.js"}'
    $enc = [Text.Encoding]::UTF8
    $idxB = $enc.GetBytes($idx)
    $pkgB = $enc.GetBytes($pkg)
    $hdr = '{"files":{"index.js":{"size":' + $idxB.Length + ',"offset":"0"},"package.json":{"size":' + $pkgB.Length + ',"offset":"' + $idxB.Length + '"}}}'
    $hdrB = $enc.GetBytes($hdr)
    $aligned = [int]([math]::Ceiling($hdrB.Length / 4) * 4)
    $pad = $aligned - $hdrB.Length
    $fs = [IO.File]::Create($outFile)
    $bw = New-Object IO.BinaryWriter($fs)
    foreach ($n in @(4, ($aligned + 8), ($aligned + 4), $hdrB.Length)) {
        $bw.Write([BitConverter]::GetBytes([int]$n))
    }
    $bw.Write($hdrB)
    if ($pad -gt 0) { $bw.Write($enc.GetBytes(('0' * $pad))) }
    $bw.Write($idxB)
    $bw.Write($pkgB)
    $bw.Flush()
    $bw.Close()
    $fs.Close()
}

function Get-RunningClients {
    $names = @('Discord','DiscordPTB','DiscordCanary','DiscordDevelopment','Vesktop')
    return @(Get-Process -Name $names -ErrorAction SilentlyContinue)
}

# 0 = нет процессов, 1 = закрыли, 2 = остались запущены
function Close-Clients([bool]$interactive) {
    $procs = Get-RunningClients
    if ($procs.Count -eq 0) { return 0 }
    $names = ($procs | Select-Object -ExpandProperty ProcessName -Unique | Sort-Object) -join ', '
    if (-not $interactive) { return 2 }
    Info ('Запущено: ' + $names)
    $ans = Read-YesNo 'Закрыть их сейчас, чтобы применить сборку?' $true
    if (-not $ans) { return 2 }
    $procs | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
    Ok 'Клиенты закрыты'
    return 1
}

function Patch-Discord {
    $patcherFile = Join-Path $DistDir 'patcher.js'
    if (-not (Test-Path $patcherFile)) {
        Err 'Нет patcher.js - сначала собери (режим install/build-only)'
        return $false
    }
    $n = 0
    foreach ($di in (Find-DiscordInstalls)) {
        $res = $di.Resources
        $appAsar = Join-Path $res 'app.asar'
        $backupAsar = Join-Path $res '_app.asar'
        if (Test-Path $backupAsar) {
            New-VencordAsar $patcherFile $appAsar
            Ok ('Discord ' + $di.Branch + ': патч обновлён (оригинал хранится как _app.asar)')
            $n++
            continue
        }
        if (Test-Path $appAsar) {
            try {
                Rename-Item $appAsar '_app.asar' -Force
                New-VencordAsar $patcherFile $appAsar
                Ok ('Discord ' + $di.Branch + ': пропатчен, оригинал сохранён как _app.asar')
                $n++
            } catch {
                Err ('Discord ' + $di.Branch + ': не удалось пропатчить - ' + $_.Exception.Message)
            }
        }
    }
    if ($n -eq 0) { Warn 'Discord-установки не найдены (нет app.asar). Нужен сам Discord - discord.com/download' }
    return $true
}

# ---------------------------------------------------------------- настройки Vencord (autoUpdate off)
function Update-VencordSettings {
    try {
        $sdir = Join-Path $AppData 'Vencord\settings'
        $sp = Join-Path $sdir 'settings.json'
        if (-not (Test-Path $sdir)) { New-Item -ItemType Directory -Path $sdir -Force | Out-Null }
        $obj = $null
        if (Test-Path $sp) {
            try { $obj = ([IO.File]::ReadAllText($sp) | ConvertFrom-Json) } catch { $obj = $null }
        }
        if (-not $obj) {
            $obj = New-Object PSObject
        }
        $obj | Add-Member -NotePropertyName autoUpdate -NotePropertyValue $false -Force
        $obj | Add-Member -NotePropertyName autoUpdateNotification -NotePropertyValue $false -Force
        # включаем все плагины из конфига
        $pluginsObj = $obj.PSObject.Properties['plugins']
        if (-not $pluginsObj) {
            $obj | Add-Member -NotePropertyName plugins -NotePropertyValue (New-Object PSObject) -Force
        }
        foreach ($p in $Config.plugins) {
            $entry = $obj.plugins.PSObject.Properties[$p.name]
            if ($entry) {
                $obj.plugins.($p.name) | Add-Member -NotePropertyName enabled -NotePropertyValue $true -Force
            } else {
                $e = New-Object PSObject
                $e | Add-Member -NotePropertyName enabled -NotePropertyValue $true -Force
                $obj.plugins | Add-Member -NotePropertyName $p.name -NotePropertyValue $e -Force
            }
        }
        Write-JsonNoBom $sp ($obj | ConvertTo-Json -Depth 20)
        Ok 'Vencord: autoUpdate выключен (сборкой управляет VencForge), плагины включены'
    } catch {
        Warn ('Не удалось обновить settings.json Vencord: ' + $_.Exception.Message)
    }
}

# ---------------------------------------------------------------- Vesktop
function Set-Vesktop([bool]$interactive) {
    $vdir = Join-Path $AppData 'vesktop'
    if (-not (Test-Path $vdir)) {
        Info 'Vesktop не установлен - шаг пропущен'
        return $true
    }
    if (-not (Test-Path $DistDir)) { Err 'Нет сборки (dist) - сначала install/build-only'; return $false }
    $statePath = Join-Path $vdir 'state.json'
    $state = $null
    if (Test-Path $statePath) {
        try { $state = ([IO.File]::ReadAllText($statePath) | ConvertFrom-Json) } catch { $state = $null }
    }
    if (-not $state) { $state = New-Object PSObject }
    $cur = $null
    $prop = $state.PSObject.Properties['vencordDir']
    if ($prop) { $cur = $prop.Value }
    if ($cur -and ($cur -ne $DistDir)) {
        if ($interactive) {
            Warn ('vencordDir сейчас указывает на: ' + $cur)
            if (-not (Read-YesNo 'Перенаправить Vesktop на сборку VencForge?' $true)) {
                Info 'Vesktop не тронут'
                return $true
            }
        } else {
            Warn 'Авто-режим: vencordDir указывает на другую сборку - Vesktop не тронут'
            return $true
        }
    }
    $state | Add-Member -NotePropertyName vencordDir -NotePropertyValue $DistDir -Force
    Write-JsonNoBom $statePath ($state | ConvertTo-Json -Depth 20)
    Ok ('Vesktop подключён к сборке VencForge: ' + $DistDir)
    return $true
}

function Clear-Vesktop {
    $vdir = Join-Path $AppData 'vesktop'
    $statePath = Join-Path $vdir 'state.json'
    if (-not (Test-Path $statePath)) { return }
    try {
        $state = ([IO.File]::ReadAllText($statePath) | ConvertFrom-Json)
        $prop = $state.PSObject.Properties['vencordDir']
        if ($prop -and $prop.Value -eq $DistDir) {
            $state.PSObject.Properties.Remove('vencordDir')
            Write-JsonNoBom $statePath ($state | ConvertTo-Json -Depth 20)
            Ok 'Vesktop: vencordDir снят (вернулся к официальной сборке)'
        }
    } catch {
        Warn ('state.json не удалось разобрать: ' + $_.Exception.Message)
    }
}

# ---------------------------------------------------------------- удаление патча
function Unpatch-Discord {
    $n = 0
    foreach ($di in (Find-DiscordInstalls)) {
        $res = $di.Resources
        $appAsar = Join-Path $res 'app.asar'
        $backupAsar = Join-Path $res '_app.asar'
        if (-not (Test-Path $backupAsar)) { continue }
        try {
            if (Test-Path $appAsar) { Remove-Item $appAsar -Force }
            Rename-Item $backupAsar 'app.asar' -Force
            Ok ('Discord ' + $di.Branch + ': оригинал восстановлен')
            $n++
        } catch {
            Err ('Discord ' + $di.Branch + ': не удалось восстановить - ' + $_.Exception.Message)
        }
    }
    if ($n -eq 0) { Info 'Пропатченных установок Discord не найдено' }
    return $true
}

# ---------------------------------------------------------------- расписание
function Schedule-Task([bool]$interactive) {
    $bat = $null
    if (Test-Path $BatPathFile) {
        $bat = (Get-Content $BatPathFile -ErrorAction SilentlyContinue | Select-Object -First 1)
        if ($bat) { $bat = $bat.Trim() }
    }
    if (-not $bat -or -not (Test-Path $bat)) {
        if ($interactive) {
            $bat = Read-Host '  Укажи полный путь к VencForge.bat (например C:\Users\...\Downloads\VencForge.bat)'
            $bat = $bat.Trim('"')
        }
        if (-not $bat -or -not (Test-Path $bat)) {
            Err 'VencForge.bat не найден - задачу создать нельзя'
            return $false
        }
    }
    $tr = '"' + $bat + '" update'
    & schtasks.exe /Create /F /TN 'VencForge Auto-Update' /SC HOURLY /MO 6 /TR $tr | Out-Null
    if ($LASTEXITCODE -eq 0) {
        Ok 'Автообновление включено: каждые 6 часов (задача "VencForge Auto-Update")'
    } else {
        Err 'schtasks не смог создать задачу (попробуй запуск от администратора)'
        return $false
    }
    return $true
}

function Deschedule-Task {
    & schtasks.exe /Delete /TN 'VencForge Auto-Update' /F | Out-Null
    if ($LASTEXITCODE -eq 0) { Ok 'Задача автообновления удалена' }
    else { Info 'Задача автообновления не найдена' }
    return $true
}

# ---------------------------------------------------------------- сам-апдейт VencForge
function Check-SelfUpdate {
    foreach ($p in $Config.plugins) {
        $candidate = Join-Path (Join-Path $PluginsDir $p.name) 'vencforge\VencForge.ps1'
        if (Test-Path $candidate) {
            try {
                $first = (Get-Content $candidate -TotalCount 40 | Where-Object { $_ -match '^\$script:VfVersion' } | Select-Object -First 1)
                if ($first -and ($first -notlike ('*' + $script:VfVersion + '*'))) {
                    $updates = Join-Path $Root 'updates'
                    if (-not (Test-Path $updates)) { New-Item -ItemType Directory -Path $updates -Force | Out-Null }
                    Copy-Item $candidate (Join-Path $updates 'VencForge.ps1') -Force
                    Info ('Доступна новая версия VencForge (' + $first + ') - файл: ' + (Join-Path $updates 'VencForge.ps1'))
                }
            } catch { }
        }
    }
}

# ---------------------------------------------------------------- главный поток
function Invoke-Update([bool]$interactive, [string]$what) {
    # what: full | build-only | patch-only
    Load-Config
    if (-not (Test-Prereq $interactive)) { return $false }

    Info 'Обновляю Vencord...'
    $r = Update-GitRepo $Config.vencordRepo $VcDir $Config.vencordBranch
    if (-not $r.ok) { Err 'Не удалось обновить Vencord (сеть? git?)'; return $false }
    if ($r.changed) { Ok 'Vencord обновлён' } else { Info 'Vencord без изменений' }
    $vcChanged = $r.changed

    $anyPluginChanged = $false
    foreach ($p in $Config.plugins) {
        Info ('Обновляю плагин ' + $p.name + '...')
        $rp = Update-GitRepo $p.url (Join-Path $PluginsDir $p.name) 'main'
        if (-not $rp.ok) { Warn ('Плагин ' + $p.name + ': git не обновился'); continue }
        if ($rp.changed) { Ok ('Плагин ' + $p.name + ' обновлён'); $anyPluginChanged = $true }
        else { Info ('Плагин ' + $p.name + ' без изменений') }
    }
    Check-SelfUpdate

    Sync-Plugins | Out-Null

    $needBuild = $true
    if ($what -ne 'patch-only') {
        if (-not $interactive) {
            $distExists = Test-Path (Join-Path $DistDir 'patcher.js')
            if ($distExists -and -not $vcChanged -and -not $anyPluginChanged) {
                Info 'Изменений нет - пересборка пропущена'
                $needBuild = $false
            }
        }
        if ($needBuild) {
            if (-not (Build-Vencord)) { return $false }
        }
    }

    if ($what -eq 'build-only') { return $true }

    $clients = Close-Clients $interactive
    if ($clients -eq 2) {
        Warn 'Клиенты запущены - патч пропущен. Перезапусти VencForge, когда закроешь Discord/Vesktop.'
        return $true
    }

    if (-not (Patch-Discord)) { return $false }
    Update-VencordSettings
    Set-Vesktop $interactive | Out-Null

    Ok ('Готово (VencForge ' + $script:VfVersion + '). Запускай Discord/Vesktop.')
    return $true
}

function Invoke-Uninstall([bool]$interactive) {
    Load-Config
    $clients = Close-Clients $interactive
    if ($clients -eq 2) { Warn 'Discord/Vesktop запущены - закрой их и повтори'; return $false }
    Unpatch-Discord | Out-Null
    Clear-Vesktop
    Deschedule-Task
    Ok ('VencForge снят с клиентов. Папка ' + $Root + ' оставлена (удали руками, если не нужна).')
    return $true
}

function Show-Doctor {
    Info ('VencForge ' + $script:VfVersion)
    $gv = (& git --version 2>$null) -join ''
    $nv = (& node -v 2>$null) -join ''
    $pv = (& corepack pnpm -v 2>$null) -join ''
    Info ('git: ' + $(if ($gv) { $gv } else { 'НЕ НАЙДЕН' }))
    Info ('node: ' + $(if ($nv) { $nv } else { 'НЕ НАЙДЕН' }))
    Info ('pnpm (corepack): ' + $(if ($pv) { $pv } else { 'НЕ НАЙДЕН' }))
    Info ('workspace: ' + $Workspace)
    Info ('dist: ' + $DistDir + ' - ' + $(if (Test-Path (Join-Path $DistDir 'patcher.js')) { 'сборка есть' } else { 'нет сборки' }))
    foreach ($p in $Config.plugins) {
        Info ('плагин из конфига: ' + $p.name + ' -> ' + $p.url)
    }
    $installs = Find-DiscordInstalls
    foreach ($di in $installs) {
        $patched = Test-Path (Join-Path $di.Resources '_app.asar')
        Info ('Discord ' + $di.Branch + ': ' + $di.Resources + ' - ' + $(if ($patched) { 'пропатчен' } else { 'оригинал' }))
    }
    $statePath = Join-Path $AppData 'vesktop\state.json'
    if (Test-Path $statePath) {
        $vdir = $null
        try {
            $st = ([IO.File]::ReadAllText($statePath) | ConvertFrom-Json)
            $prop = $st.PSObject.Properties['vencordDir']
            if ($prop) { $vdir = $prop.Value }
        } catch { }
        Info ('Vesktop vencordDir: ' + $(if ($vdir) { $vdir } else { 'по умолчанию (официальный Vencord)' }))
    }
    if (Test-Path $LogFile) {
        Info ('лог: ' + $LogFile)
        Get-Content $LogFile -Tail 5 | ForEach-Object { Write-Host ('    | ' + $_) -ForegroundColor DarkGray }
    }
    return $true
}

# ---------------------------------------------------------------- меню
function Show-Menu {
    while ($true) {
        Write-Host ''
        Write-Host ('================================ VencForge ' + $script:VfVersion + ' ================================') -ForegroundColor Magenta
        Write-Host ' 1 - Установить/обновить всё (Vencord + плагины + Discord + Vesktop)'
        Write-Host ' 2 - Только пересобрать (без патча клиентов)'
        Write-Host ' 3 - Починить Discord (перепатчить после обновления Discord)'
        Write-Host ' 4 - Убрать VencForge из Discord/Vesktop (вернуть оригинал)'
        Write-Host ' 5 - Автообновление по расписанию: включить / выключить'
        Write-Host ' 6 - Диагностика (для поддержки)'
        Write-Host ' 0 - Выход'
        $choice = Read-Host 'Выбери номер'
        switch ($choice) {
            '1' { Invoke-Update $true 'full' | Out-Null }
            '2' { Invoke-Update $true 'build-only' | Out-Null }
            '3' { Load-Config; if (Test-Prereq $true) { if ((Close-Clients $true) -ne 2) { Patch-Discord | Out-Null; Update-VencordSettings; Set-Vesktop $true | Out-Null } } }
            '4' { Invoke-Uninstall $true | Out-Null }
            '5' {
                $task = Get-ScheduledTask -TaskName 'VencForge Auto-Update' -ErrorAction SilentlyContinue
                if ($task) { if (Read-YesNo 'Задача есть. Удалить её?' $false) { Deschedule-Task | Out-Null } }
                else { Schedule-Task $true | Out-Null }
            }
            '6' { Show-Doctor | Out-Null }
            '0' { return }
            default { }
        }
        Write-Host ''
        Read-Host 'Enter - вернуться в меню'
    }
}

# ---------------------------------------------------------------- запуск
Write-Host ('VencForge ' + $script:VfVersion + ' - свой билдер Vencord с плагинами из Git') -ForegroundColor Magenta
try {
    switch ($script:Mode) {
        'install'    { Invoke-Update $true 'full' | Out-Null; if ($script:Mode -eq 'install') { Read-Host 'Enter - выход' | Out-Null } }
        'update'     { Invoke-Update $false 'full' | Out-Null }
        'repair'     { Load-Config; if (Test-Prereq $false) { $c = Close-Clients $false; if ($c -ne 2) { Patch-Discord | Out-Null; Update-VencordSettings } } }
        'build-only' { Invoke-Update $true 'build-only' | Out-Null; Read-Host 'Enter - выход' | Out-Null }
        'uninstall'  { Invoke-Uninstall $true | Out-Null; Read-Host 'Enter - выход' | Out-Null }
        'schedule'   { Load-Config; Schedule-Task $true | Out-Null; Read-Host 'Enter - выход' | Out-Null }
        'deschedule' { Deschedule-Task | Out-Null; Read-Host 'Enter - выход' | Out-Null }
        'doctor'     { Show-Doctor | Out-Null; Read-Host 'Enter - выход' | Out-Null }
        default      { Load-Config; Show-Menu }
    }
} catch {
    Err ('Непредвиденная ошибка: ' + $_.Exception.Message)
    Write-Log ('FATAL ' + $_.Exception.Message)
    Read-Host 'Enter - выход'
    exit 1
}

