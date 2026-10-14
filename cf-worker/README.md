# Деплой и настройка Cloudflare Worker (P2PStream Broker)

## Обзор

**Worker URL:** `https://shrill-shape-9a12.kosyakmilya.workers.dev/mqtt`

**Назначение:** MQTT-сигналинг для P2PStream v1.23+ с аутентификацией по shared secret и фильтрацией по голосовому каналу.

## Функции v1.23

- ✅ **Аутентификация:** `CONNECT` требует `password = BROKER_SECRET` (env-переменная)
- ✅ **Фильтрация по каналу:** `clientId = userId:channelId` → воркер знает, кто в каком канале
- ✅ **Приватные стримы:** announce публикуются в `p2ps/v1/s/<streamId>` (не в общий канал)
- ✅ **Безопасность топиков:** `*` запрещён, `+` разрешён только в `p2ps/v1/u/+`

## Деплой (через wrangler CLI)

```bash
# 1. Установить wrangler (если нет)
npm install -g wrangler

# 2. Войти в Cloudflare
wrangler login

# 3. Перейти в папку воркера
cd cf-worker

# 4. Деплой
wrangler deploy
```

### wrangler.toml

```toml
name = "p2ps-broker"
main = "worker.js"
compatibility_date = "2026-10-08"

[[durable_objects.bindings]]
name = "BROKER"
class_name = "Broker"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["Broker"]
```

### Настройка переменных окружения

После деплоя:

1. Зайти в [Cloudflare Dashboard](https://dash.cloudflare.com/) → Workers & Pages → `p2ps-broker`
2. Settings → Variables and Secrets → **Add binding**
3. Тип: **Environment Variable**
4. Имя: `BROKER_SECRET`
5. Значение: сгенерировать в настройках плагина (кнопка «🔑 Сгенерировать»)
6. Сохранить → **Deploy** (пересоздать деплой)

## Деплой (через Dashboard)

1. **Создать Worker:**
   - Workers & Pages → Create → Deploy
   - Имя: `p2ps-broker`
2. **Вставить код:**
   - Quick Edit → вставить `cf-worker/worker.js` целиком
   - Deploy
3. **Добавить Durable Object:**
   - Settings → Bindings → Add → Durable Object Namespace
   - Class name: `Broker`
   - Namespace name: `BROKER`
4. **Добавить переменную:**
   - Settings → Variables and Secrets → Add binding
   - Name: `BROKER_SECRET`
   - Value: (сгенерировать в плагине)
5. **Пересоздать деплой** (чтобы переменная применилась)

## Проверка работоспособности

```bash
# Тест через MQTT-клиент (npm install -g mqtt)
mqtt_sub -t 'p2ps/v1/#' -h 'wss://shrill-shape-9a12.kosyakmilya.workers.dev/mqtt'

# Или через test-скрипт в репо (если есть)
node cf-worker/test-mqtt.mjs wss://shrill-shape-9a12.kosyakmilya.workers.dev/mqtt
```

Ожидаемый результат:
- CONNACK rc=0 при верном `BROKER_SECRET`
- CONNACK rc=5 при неверном пароле
- Анонсы стримов приходят в топик `p2ps/v1/c/<channelId>`

## Интеграция с плагином P2PStream

В настройках плагина:

1. **Broker URL:** `wss://shrill-shape-9a12.kosyakmilya.workers.dev/mqtt`
2. **Broker Secret:** (скопировать из Cloudflare или сгенерировать в плагине)
3. **Включить брокер:** ✅

После сохранения плагин автоматически переподключится с новым clientId (`userId:channelId`) и паролем.

## Отладка

### Логи воркера

1. Workers & Pages → `p2ps-broker` → **Logs** (или `wrangler tail p2ps-broker`)
2. Фильтровать по `[p2ps-broker]`

Ожидаемые сообщения:
- `Client <userId>:<channelId> connected successfully`
- `Bad password for client <clientId>` (если секрет не совпадает)
- `BROKER_SECRET not set in env` (если переменная не задана)

### Частые проблемы

| Проблема | Решение |
|----------|---------|
| CONNACK rc=5 | Проверить `BROKER_SECRET` в Cloudflare и плагине |
| «таймаут (нет CONNACK)» | Проверить, что Durable Object добавлен |
| Анонсы не приходят | Проверить подписку на `p2ps/v1/c/<channelId>` |
| clientId не парсится | Убедиться, что формат `userId:channelId` (без пробелов) |

## Миграция со старых версий

**v1.22 → v1.23:**

1. Обновить воркер (деплой нового `worker.js`)
2. Добавить `BROKER_SECRET` в переменные
3. В плагине: сгенерировать секрет, скопировать в Cloudflare
4. Перезагрузить Discord (или хот-свап через `p2ps://connect`)

**Старый формат clientId (`p2ps-xxx`) → новый (`userId:channelId`):**
- Автоматически: плагин v1.23+ сам шлёт правильный формат
- Воркер совместим с обоими форматами (старые клиенты без channelId работают без фильтрации)

## Безопасность

- `BROKER_SECRET` — это shared secret, **не передавать публично**
- Ссылка-приглашение (`p2ps://connect?broker=...&secret=...`) содержит секрет — отправлять **только в ЛС или приватный чат**
- Воркер не хранит секреты, только сверяет с env

## API Reference

### CONNECT Packet

```
Flags: 0xc2 (clean + username + password)
Payload:
  - protocol: "MQTT"
  - level: 0x04 (3.1.1)
  - flags: 0xc2
  - keepalive: 60 сек
  - clientId: "<userId>:<channelId>"
  - username: "<userId>:<channelId>" (дублируется для протокола)
  - password: "<BROKER_SECRET>"
```

### CONNACK Codes

- `0x00` — успешно
- `0x05` — неверный пароль (BROKER_SECRET не совпадает)

### Топики

| Топик | Назначение |
|-------|------------|
| `p2ps/v1/u/<userId>` | Личный ящик (адресные сигналы: join, offer, answer, ice) |
| `p2ps/v1/c/<channelId>` | Голосовой канал (announce, query, bye) |
| `p2ps/v1/s/<streamId>` | Приватный стрим (announce только для allowedViewers) |
| `p2ps/v1/u/+` | Wildcard для подписки на свой ящик (разрешён только `+` в конце) |

## Changelog

### v1.23 (2026-10-14)

- ✅ Аутентификация через `CONNECT` password
- ✅ `clientId = userId:channelId` для фильтрации по каналу
- ✅ `voiceChannels` Map для отслеживания кто в каком канале
- ✅ Приватные стримы (`allowedViewers` в announce)
- ✅ Запрет `*` wildcard, `+` только в `p2ps/v1/u/+`

### v1.22

- Базовый MQTT на Durable Objects
- Без аутентификации