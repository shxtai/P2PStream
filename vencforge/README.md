# VencForge

Свой менеджер сборок Vencord: **сборка из исходников + плагины из Git + патч Discord/Vesktop + автообновление**. Один файл — `VencForge.bat`.

Зачем он, если есть veskforge:

| | veskforge | VencForge |
|---|---|---|
| Vesktop | да | да (через `vencordDir` в `state.json`) |
| Обычный Discord (Stable/PTB/Canary) | нет | **да** (asar-патч, как у официального инсталлера) |
| «Голый» Discord без Vencord | нет | **да**, ставит с нуля |
| Уже стоящий Vencord от инсталлера | нет | **да**, переезжает на нашу сборку |
| Плагины из Git | да | **да** (список в `config.json`, сколько угодно) |
| Обновление после апдейта Discord | вручную | **сам** (или по расписанию) |
| Откат на оригинал | нет | **да** (пункт 4 меню / `uninstall`) |

## Как пользоваться

1. Скачай `VencForge.bat` и запусти двойным кликом (можно из любого места — хоть с рабочего стола).
2. Первым делом он предложит «1 — Установить/обновить всё». Дальше всё сам:
   - проверит Git и Node.js (18+); если нет — поставит через winget (попросит подтверждение UAC);
   - клонирует в `%APPDATA%\VencForge\workspace` свежий Vencord (main) и все плагины из `config.json`;
   - соберёт Vencord с плагинами (pnpm через corepack), положит результат в `%APPDATA%\VencForge\dist`;
   - пропатчит все найденные Discord (оригинал каждого сохраняется рядом как `_app.asar`);
   - подключит Vesktop, если он установлен (перезаписывает `vencordDir` в `%APPDATA%\vesktop\state.json`);
   - выключит автообновление Vencord (`%APPDATA%\Vencord\settings\settings.json`), чтобы официальный апдейтер не затирал нашу сборку, и включит плагины.
3. Запусти Discord/Vesktop. В настройках Vencord: **Plugins → P2PStream → Enable**.

## Режимы (аргумент батника)

| Команда | Что делает |
|---|---|
| `VencForge.bat` | интерактивное меню |
| `VencForge.bat install` | обновить репозитории + собрать + пропатчить (с вопросами) |
| `VencForge.bat update` | то же без вопросов (используется планировщиком; пересобирает только если что-то реально обновилось, а если Discord/Vesktop запущены — отложит патч до следующего раза) |
| `VencForge.bat repair` | перепатчить Discord текущей сборкой (после обновления Discord) |
| `VencForge.bat build-only` | обновить и пересобрать, клиентов не трогать |
| `VencForge.bat uninstall` | восстановить оригинальные `app.asar`, отвязать Vesktop, снять задачу расписания |
| `VencForge.bat schedule` | автообновление каждые 6 часов (задача «VencForge Auto-Update») |
| `VencForge.bat deschedule` | убрать задачу |
| `VencForge.bat doctor` | диагностика: версии, состояние патчей, хвост лога — удобно прислать при проблемах |

## Свои плагины

Открой `%APPDATA%\VencForge\config.json`:

```json
{
  "vencordRepo": "https://github.com/Vendicated/Vencord",
  "vencordBranch": "main",
  "plugins": [
    { "name": "P2PStream", "url": "https://github.com/shxtai/P2PStream" },
    { "name": "MyOtherPlugin", "url": "https://github.com/user/repo" }
  ]
}
```

Каждый репозиторий — стандартный userplugin: `index.ts(x)/js(x)` в корне или ровно в одной подпапке. VencForge сам тянет последний `main` и пересобирает всё разом.

## Самообновление VencForge

Скрипт хранится в репозитории плагина (`vencforge/VencForge.ps1`), поэтому обновляется вместе с плагинами: если в репо появилась более новая версия — VencForge положит её в `%APPDATA%\VencForge\updates\VencForge.ps1` и сообщит об этом.

## Важно

- Патч перезаписывает `modules/discord_desktop_core/discord_desktop_core/app.asar` на загрузчик, который требует `patcher.js` из `%APPDATA%\VencForge\dist`. Оригинал лежит рядом как `_app.asar` — «4» в меню или `uninstall` возвращает всё как было.
- Не используй veskforge и VencForge на одном клиенте одновременно — они перетягивают `vencordDir` друг у друга. Выбери один менеджер.
- Обновился Discord и слетел Vencord? Запусти `VencForge.bat repair` (или пункт 3 меню) — патч встанет на новую версию.
- Логи: `%APPDATA%\VencForge\logs\vencforge.log`.
- Сборка идёт локально: все файлы плагинов и исходники Vencord лежат у тебя на диске, ничего кроме публичных GitHub-репозиториев не скачивается.

## Технические детали

- asar-патч: переименование `app.asar` → `_app.asar` + запись кастомного asar (`package.json` с `main: index.js`, где `index.js` — `require("<путь к patcher.js>")`). Формат заголовка asar генерируется на месте (pickle-заголовок, выравнивание 4 байта).
- Vesktop грузит из `vencordDir` ровно 4 файла: `vencordDesktopMain.js`, `vencordDesktopPreload.js`, `vencordDesktopRenderer.js`, `vencordDesktopRenderer.css` — полная сборка Vencord их все содержит.
- `settings.json` Vencord и `state.json` Vesktop пишутся строго UTF-8 **без BOM** — иначе парсеры JSON обоих падают.
- `pnpm` вызывается через `corepack pnpm` — глобальная установка pnpm не нужна и прав администратора не требует.
