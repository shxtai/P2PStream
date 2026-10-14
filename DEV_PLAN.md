# 🎯 P2PStream v1.23.0 — ПЛАН РАЗРАБОТКИ

## 1. Постановка цели и таймлайна

### Цель
Сделать P2P-стриминг **неотличимым** от нативного Discord по UX, но с лучшим качеством и приватностью.

### Критерии готовности (Definition of Done)

| # | Критерий | Статус | Файл |
|---|----------|--------|------|
| 1 | `/p2p-share` отправляет embed | ✅ Готово | index.tsx |
| 2 | Хот-свап без Ctrl+R | ⏳ В работе | index.tsx |
| 3 | Фильтрация по каналу | ✅ Готово | engine.ts, worker.js |
| 4 | allowedViewers | ✅ Готово | settings.ts, engine.ts |
| 5 | Штатный плеер Discord | ✅ Готово | ViewerModal.tsx |
| 6 | Кнопка "Пригласить" в HostBar | ❌ Не сделано | ui/Bars.tsx |
| 7 | README обновлён | ❌ Не сделано | README.md |
| 8 | Тесты green | ⏳ Нужно проверить | devtest/ |

### Дедлайн
**Релиз:** 2025-01-15 18:00 MSK

---

## 2. Механика приглашения и шаринга

### ✅ Реализовано
- `/p2p-share` команда — embed с брокером, секретом, каналом
- `brokerSecret` UI — генерация + кнопка "Поделиться"
- Передача `userId:channelId` в broker (worker.js)
- Фильтрация announce по голосовому каналу

### ❌ Осталось
- Кнопка "🔗 Пригласить" в HostBar (ui/Bars.tsx)
- Авто-подключение к стриму после клика по ссылке

---

## 3. Приватность, безопасность, изоляция

### ✅ Реализовано
| Уязвимость | Решение | Файл |
|------------|---------|------|
| Спуфинг отправителя | `sig.from === msg.author.id` | engine.ts |
| MITM через ECDH | ECDSA + fingerprint | broker.ts |
| Downgrade-атака | Предупреждение при unsealed | engine.ts |
| Утечки Maps/Sets | `signalingCleanup()` | signaling.ts |
| Wildcard '*' атаки | Блокировка в topicMatches | worker.js |
| Несанкционированный доступ | BROKER_SECRET | worker.js |
| Публичные стримы | allowedViewers | settings.ts, engine.ts |

### ✅ Фильтрация по каналу
```typescript
// engine.ts:1899
const announceChannelId = sig.d?.channelId;
if (announceChannelId && voice && announceChannelId !== voice) {
    return true; // игнорируем — зритель не в том канале
}
```

---

## 4. Интеграция с Discord и UI/UX

### ✅ Нативный плеер
- ViewerModal.tsx пытается открыть штатный плеер
- Фолбэк на свою модалку если не вышло
- P2P-стрим играет внутри Discord UI

### ❌ Кнопка в HostBar
Нужно добавить в ui/Bars.tsx:
```tsx
<button onClick={inviteLink}>🔗 Пригласить</button>
```

### ⏳ Хот-свап
Сейчас: ссылка применяется, но нужно:
1. Автоматическое переподключение брокера
2. Авто-открытие стрима если есть `?stream=`

---

## 5. Документация и аудит

### ✅ Создано
- CHANGELOG_1.23.md
- IMPROVEMENTS.md
- UPDATE_SUMMARY.md

### ❌ Осталось
- README.md — обновить секцию "Быстрый старт"
- Инструкция по деплою воркера
- UX-аудит: проверить все сценарии

---

## 📋 Чеклист релиза

- [ ] Доделать кнопку "Пригласить" в Bars.tsx
- [ ] Хот-свап: авто-редирект на стрим
- [ ] Обновить README
- [ ] Прогнать devtest
- [ ] Финальный аудит кода
- [ ] Деплой воркера
- [ ] Релиз v1.23.0

---

**Приоритеты:**
1. 🔒 Безопасность (готово ✅)
2. 🎨 UX (кнопка + хот-свап)
3. 📚 Docs (README)
