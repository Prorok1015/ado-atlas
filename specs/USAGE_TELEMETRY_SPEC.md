# Usage Telemetry Spec — GA4 Measurement Protocol

> **Термины.** «Телеметрия» здесь = **анонимная аналитика использования самого расширения**
> (какие вкладки/фичи открывают, сколько активных установок). Это **не** Pro-модуль
> «Analytics 👑» из [MONETIZATION_AND_ANALYTICS_SPEC](./MONETIZATION_AND_ANALYTICS_SPEC.md)
> (тот считает Flow-метрики по данным ADO) и **не** магазинная аналитика листинга
> в Chrome Web Store (она работает сама, отдельно, без кода).

## 1. Цель

Понимать, как расширением реально пользуются: сколько активных пользователей, какие
представления (Tree/Board/Graph/Timeline) популярны, какие фичи используются, на каких
версиях сидят люди. Всё — **анонимно**, без PII, без данных рабочих элементов, без токенов.

## 2. Почему Measurement Protocol, а не gtag.js

Manifest V3 запрещает грузить внешние скрипты на страницах расширения
(`content_security_policy.extension_pages: script-src 'self'`). Значит `gtag.js` /
`analytics.js` подключить нельзя. Единственный корректный путь — **GA4 Measurement
Protocol**: события отправляются обычным `fetch` POST на
`https://www.google-analytics.com/mp/collect`.

## 3. Архитектура (что уже реализовано в коде)

```
UI-страница (index.html)                 Service Worker (background.js)          Google
  App.analytics.track(name, params)  ──►  chrome.runtime.onMessage {action:'ga'}
  src/app/analytics.js                      └─► AdoAnalytics.collect(name, params) ──► POST /mp/collect
                                            src/core/analytics.js
```

| Слой | Файл | Роль |
|------|------|------|
| Page facade | `src/app/analytics.js` | `App.analytics.track(name, params)` — fire-and-forget, шлёт событие воркеру через `chrome.runtime.sendMessage({action:'ga'})`. Страница **никогда** не обращается к GA напрямую → CSP страницы не меняется. |
| Worker core | `src/core/analytics.js` | GA4-клиент: строит payload, ставит `client_id`/`session_id`/`app_version`, делает POST. `importScripts` в `background.js`. |
| Транспорт | `background.js` | Обработчик `action:'ga'` + события жизненного цикла (`extension_install`/`extension_update`). |
| Permission | `manifest.json` | `host_permissions: "https://www.google-analytics.com/*"` — нужен, чтобы воркер мог сделать cross-origin `fetch`. **CSP `connect-src` НЕ трогаем** (страница к GA не ходит). |
| Opt-out | `src/app/prefs.js` (`telemetry`), `src/app/settings.js`, `index.html` (`#f_telemetry`) | Переключатель в настройках. Pref роумится (area:'sync', worker:true), читается воркером. |

**Anonymity:** `client_id` — случайный UUID в `chrome.storage.local['ga_client_id']`,
не связан с аккаунтом и **отдельный** от `installation_id` (тот — для лицензий, см.
[PREMIUM_IMPLEMENTATION_DESIGN](./PREMIUM_IMPLEMENTATION_DESIGN.md)).

## 4. Как включить ПРАВИЛЬНО (пошагово)

Пока в `src/core/analytics.js` стоят плейсхолдеры `MEASUREMENT_ID = 'G-XXXXXXXXXX'` и
`API_SECRET = 'REPLACE_WITH_API_SECRET'`, функция `configured()` блокирует любые сетевые
запросы. Телеметрия начнёт работать только после шагов ниже.

1. **Завести ОТДЕЛЬНЫЙ GA4 property под телеметрию расширения.**
   Не переиспользовать поток, который Chrome Web Store привязал к листингу — у него, как
   правило, нет доступа к Measurement Protocol, и смешивать «трафик листинга» с «внутренним
   использованием» вредно для чистоты данных. Google Analytics → Admin → **Create property**.
2. Внутри property создать **Data stream** типа **Web** (URL можно указать `homepage_url`
   расширения — он не влияет на приём MP-событий). Скопировать **Measurement ID** (`G-XXXXXXXXXX`).
3. В этом же потоке: **Measurement Protocol API secrets → Create** → скопировать `api_secret`.
4. Вписать оба значения в `src/core/analytics.js` (константы `MEASUREMENT_ID`, `API_SECRET`).
5. Прогнать тесты (`npm test`), собрать (`npm run build`), проверить в DebugView (см. §7).

## 5. Модель безопасности секрета

`api_secret` Measurement Protocol — **write-only ingest-ключ**: им можно только слать
события в поток. Им **нельзя** читать отчёты/данные, входить в аккаунт, менять или удалять
собранное. Поэтому его размещение в клиентском коде — штатная модель Google, а не утечка
секрета (в отличие от ADO PAT / ключа OpenAI — те под «secrets firewall», см.
[SETTINGS_SYNC_SPEC](./SETTINGS_SYNC_SPEC.md), и в код не попадают).

- **Единственный риск** — спам-накрутка фейковыми событиями. Снижается тем, что property
  отдельный (пачкается только он) и ключ **отзывается/пересоздаётся одним кликом** в GA4.
- **Абсолютная защита (опционально, оверкилл для usage-аналитики):** проксировать события
  через собственный бэкенд, хранящий `api_secret` на сервере — см. §8.

## 6. Приватность и требования Chrome Web Store

Сбор телеметрии обязывает к раскрытию. Перед публикацией версии с включённой телеметрией:

- [ ] **Privacy policy** обновлена: что собираем (анонимные usage-события), что НЕ собираем
      (PII, данные рабочих элементов, токены), что данные уходят в Google Analytics.
- [ ] В Developer Dashboard → **Privacy practices** отмечена категория данных
      («Website content» / «User activity» в анонимном виде) и заполнено обоснование.
- [ ] Opt-out доступен пользователю (реализован: Settings → «Usage analytics»).
- [ ] Модель — **opt-out** (по умолчанию включено). Если юрисдикция/политика потребует
      **opt-in** (GDPR-строгий вариант) — поменять дефолт: `enabled()` в
      `src/core/analytics.js` возвращать `false` при `undefined`, и показывать consent-баннер
      при первом запуске.

## 7. Проверка

- **GA4 DebugView** (Admin → DebugView) показывает события в реальном времени. Чтобы событие
  туда попало, можно временно слать на `/debug/mp/collect` (валидирует payload и возвращает
  ошибки) или добавить в payload `params: { debug_mode: 1 }`.
- **Realtime-отчёт** GA4 — активные пользователи в последние 30 минут.
- Проверить, что при `telemetry='off'` (переключатель в настройках) **ни одного** POST на
  `google-analytics.com` в Network воркера.
- Проверить, что с плейсхолдерами (`configured()===false`) сеть молчит.

## 8. Опция на будущее: бэкенд-прокси (не реализовано)

Если понадобится 0% возможности накрутки — слать не напрямую в Google, а через Go-бэкенд
(там уже есть seam: `fetchHostedAI` / `validateLicenseBackground` в `background.js`):

```
расширение → POST /api/telemetry (свой бэкенд, хранит api_secret) → GA4 /mp/collect
```

Тогда из `src/core/analytics.js` уезжает `API_SECRET`, а `ENDPOINT` меняется на свой
`/api/telemetry`. Для usage-аналитики расширения это избыточно; фиксируем как возможный шаг.

## 9. Таксономия событий (текущая)

| Событие | Где фичется | Параметры |
|---------|-------------|-----------|
| `extension_install` | `background.js` onInstalled (`reason==='install'`) | — |
| `extension_update` | `background.js` onInstalled (`reason==='update'`) | `previous_version` |
| `app_open` | `src/app/boot.js` при DOMContentLoaded | `lang` |
| `view_change` | `src/app/settings.js` `switchMode` | `mode` (tree/board/graph/timeline) |

Все события автоматически получают `app_version`, `session_id`, `engagement_time_msec`.
Новые события добавляются вызовом `App.analytics.track('event_name', { ... })` на странице
или `AdoAnalytics.collect(...)` в воркере. Имена — `snake_case`, ≤40 символов, начинаются
с буквы (санитизация в `sanitizeName`). **Никаких PII/ADO-данных в параметрах.**
