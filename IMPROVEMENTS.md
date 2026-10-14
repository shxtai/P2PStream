# P2PStream — Улучшения v1.23

## 🔐 Безопасность

### Исправленные уязвимости
- ✅ Спуфинг отправителя — проверка `sig.from === msg.author.id`
- ✅ MITM через ECDH — ECDSA-подпись + fingerprint
- ✅ Downgrade-атака — предупреждение при unsealed
- ✅ Утечки Maps/Sets — `signalingCleanup()`
- ✅ Гонка `createPeer` — `delete()` до `close()`

### MQTT-брокер аутентификация
- ✅ Shared-secret аутентификация (BROKER_SECRET в wrangler env)
- ✅ Wildcard блокировка — только `p2ps/v1/u/+` допускается
- ✅ Аутентификация при CONNECT — проверка пароля
- ✅ Безопасный логгер для отладки

## 🎬 Приватные стримы

### Как это работает
Стример может указать, кто может видеть его эфир через:
- Настройку `privateStream` (вкл/выкл)
- Настройку `allowedViewers` (список Discord ID через запятую)

Когда приватный стрим включен:
- Announce публикуются в топик `p2ps/v1/s/<streamId>` (не в общий канал)
- В announce включается поле `allowedViewers` со списком разрешенных ID
- Зритель проверяет, что его ID в списке перед принятием соединения

### UI улучшения
- ✅ Кнопка "🔑 Сгенерировать" для brokerSecret в настройках
- ✅ Кнопка "📤 Поделиться" ссылкой с brokerUrl + secret
- ✅ Кнопка "🔗 Пригласить" в HostBar для генерации ссылки-приглашения
- ✅ Команда `/p2p-share` — отправка приглашения в чат
- ✅ Автоприменение настроек из ссылки `p2ps://connect`

## 🔊 Голосовые каналы и фильтрация

### Как работает
Брокер теперь учитывает голосовой канал при подключении:
- clientId в CONNECT имеет формат `userId:channelId`
- Брокер сохраняет связь между соединением и голосовым каналом
- При публикации announce в топик стрима, брокер может фильтровать по каналу
- В планах: announce будут рассылаться только тем, кто в том же голосовом канале

### Преимущества
- Уменьшение шума в брокере (меньше ненужных announce)
- Лучшая приватность по умолчанию
- Подготовка к полной фильтрации по голосовому каналу

## 🛠 Настройка брокера

### Cloudflare Workers (обновлено)
1. **wrangler.toml**:
```toml
name = "p2ps-broker"
main = "worker.js"
compatibility_date = "2025-01-01"

[[durable_objects.bindings]]
name = "BROKER"
class_name = "Broker"

[vars]
BROKER_SECRET = "your-base64-secret-here"  # сгенерировать кнопкой в настройках
```

2. **Биндинг**:
   - Class: `Broker`
   - Namespace: `BROKER`

3. **Деплой**:
   ```bash
   npm install -g wrangler
   wrangler login
   wrangler deploy
   ```

### Своё окружение
- **Mosquitto** на своём сервере с `protocol websockets`
- **BROKER_SECRET** задать через переменную окружения

## 📋 Чек-лист для пользователя

### Обновление существующего деплоя
- [ ] Обновить cf-worker/worker.js с новой версией
- [ ] Добавить BROKER_SECRET в wrangler vars (или в dashboard)
- [ ] Выполнить `wrangler deploy` или передеплоить через dashboard
- [ ] Проверить деплой: `wrangler whoami` или проверить health-check

### Первый запуск с аутентификацией
- [ ] Сгенерировать brokerSecret в настройках P2PStream (кнопка "🔑 Сгенерировать")
- [ ] Скопировать secret в wrangler vars или dashboard
- [ ] Передеплоить worker
- [ ] В настройках P2PStream указать brokerUrl и включить brokerEnabled
- [ ] Протестировать `/p2p-doctor`

## 📚 Документация

- [IMPROVEMENTS.md](IMPROVEMENTS.md) — обзор всех изменений
- [PRIVATE_STREAMS.md](PRIVATE_STREAMS.md) — приватные стримы
- [QUICKSTART.md](QUICKSTART.md) — быстрый старт
- [TODO.md](TODO.md) — планы на будущее

---

**Версия:** v1.23.0  
**Последнее обновление:** 2025-01-14