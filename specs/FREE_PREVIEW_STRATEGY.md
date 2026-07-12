# Free Preview Strategy — Pro features в открытом доступе

## Цель

Привлечь пользователей и создать привычку к Pro-функциональности **до запуска платной подписки**.
Все preview-фичи должны быть **чётко маркированы** как Pro с первого дня, чтобы при переходе
на платную модель пользователи не чувствовали, что у них забрали бесплатное.

---

## Классификация фич

### ✅ FREE PREVIEW — доступны бесплатно, помечены как Pro

| Ключ | Фича | Обоснование |
|------|-------|-------------|
| `analytics` (весь блок, включая `an_*`) | **Analytics Module** — Cycle Time, CFD, Aging, Burndown, Velocity, Stale, Blocked, Team Throughput, Avg Closure Time, Top Performer | Высокая «липкость». Люди привыкают к метрикам и не могут без них. Нулевая серверная стоимость (Revisions API → клиентские расчёты) |
| `conditional_formatting` | **Conditional Formatting** | Визуально трансформирует доску. После настройки правил пользователь «привязан» |
| `quick_templates` | **Quick Templates** | Экономит время каждый день. Настроенные шаблоны — сильный retention-фактор |
| `export` | **Advanced Export** (SVG/PDF/Excel) | Низкая стоимость реализации. Полезно для отчётов руководству. Крючок для тимлидов |
| `ultra_dark` | **Ultra Dark theme** | Почти нулевые затраты на поддержку. Создаёт ощущение «премиума» |
| `premium_white` | **Premium White theme** | Аналогично Ultra Dark — низкие затраты, приятный бонус для любителей светлых тем |

### ❌ НЕ в preview — только для платных подписчиков

| Ключ | Фича | Причина |
|------|-------|---------|
| `cloud_ai` | Cloud AI | Стоит денег за каждый запрос (серверные расходы на LLM) |
| `hosted_oauth` | Hosted OAuth | Требует бэкенд-инфраструктуру |
| `filter_presets` | Cloud Filter Sync | Требует серверную часть для синхронизации |
| `shared_views` | Shared Views | Team-фича, целевая аудитория — компании с бюджетом |
| `tv_dashboard` | TV Dashboard | Team-фича |
| `scheduled_reports` | Scheduled Reports | Team-фича |
| `cross_project` | Cross-Project | Team-фича |
| `share_link` | Share Link | Требует бэкенд |

### ⚪ Обычные Pro-фичи (без preview, но и без серверных затрат)

| Ключ | Фича | Примечание |
|------|-------|-----------|
| `saved_views` | Saved Views | Локальная фича, но оставляем для монетизации |
| `swimlanes` | Swimlanes | Оставляем для монетизации |
| `critical_path` | Critical Path | Оставляем для монетизации |
| `baseline_gantt` | Gantt Baseline | Оставляем для монетизации |

---

## Механизм гейтинга

### Три состояния фичи в `EntitlementManager`:

```
free     → показать paywall (как сейчас)
preview  → фича работает + показывает бейдж "PRO · Free Preview"
pro      → фича работает без бейджей
```

### Изменения в `EntitlementManager`:

```js
// Список фич в бесплатном preview
const PREVIEW_FEATURES = new Set([
  'analytics', 'an_cycle', 'an_cfd', 'an_aging', 'an_burndown',
  'an_velocity', 'an_stale', 'an_blocked',
  'an_team_throughput', 'an_team_avg_cycle', 'an_team_top',
  'conditional_formatting', 'quick_templates', 'export',
  'ultra_dark', 'premium_white'
]);

// gate() логика:
// - Если isPro() → разрешить (полный Pro)
// - Если PREVIEW_FEATURES.has(feature) → разрешить + показать preview-бейдж
// - Иначе → показать paywall
```

### Таймлайн preview:

- **Начало**: момент публикации версии с preview-фичами
- **Окончание**: 30 дней после запуска платной подписки (настраивается)
- **Переход**: за 7 дней до окончания — уведомление в расширении

---

## UX: маркировка preview-фич

### 1. Бейдж в тулбаре / настройках

Рядом с каждой preview-фичей — бейдж:

```
⭐ PRO · Free Preview
```

Цвет: золотой градиент (как у текущего PRO бейджа), но с дополнительной пометкой.

### 2. Баннер при первом использовании

При первом открытии preview-фичи — ненавязчивый баннер сверху:

> ⭐ **This is a Pro feature — free during the preview!**
> Enjoy full access now. This feature will require a Pro subscription in the future.
> [Learn more about Pro →]

- Показывается **один раз** (запоминается в `chrome.storage.local`)
- Кнопка «Learn more» → открывает ProFeaturesPanel

### 3. В каталоге Pro Features

Статус `preview` вместо `planned`:

```
🟢 preview   — зелёный бейдж "Free Preview"
🟡 partial   — жёлтый (как сейчас)
⚪ planned   — серый (как сейчас)
🔵 stub      — синий (как сейчас)
```

### 4. В paywall

Если пользователь кликает на preview-фичу в paywall — вместо «Activate License»
показать: «This feature is currently free! [Open →]»

---

## Коммуникация (changelog / store listing)

### Chrome Web Store описание (дополнение):

> 🎁 **Free Preview**: Try premium features like Analytics Dashboard, Conditional Formatting,
> Quick Templates, and premium themes — free during the preview period!

### In-app первый запуск (что-то вроде "What's New"):

> **ADO Atlas Pro Preview is here!** 🎉
> We've unlocked several Pro features for you to try — completely free.
> They'll become part of the paid Pro tier in the future, but for now — enjoy!

---

## Зависимости

- Требует реализации самих фич (Stage 3 из PREMIUM_IMPLEMENTATION_DESIGN.md)
- НЕ требует бэкенда — preview-список хардкодится на клиенте
- При запуске бэкенда — preview-список может переехать в серверный конфиг для гибкого управления
