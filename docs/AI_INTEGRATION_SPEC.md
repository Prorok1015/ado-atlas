# AI-интеграция — спецификация (v0.1)

Общий AI-слой для расширения ADO Atlas: абстракция провайдера, независимая от конкретной
фичи, и первый потребитель — AI-поиск по work items через конструктор фильтров.

**Зависимость:** FILTER_CONSTRUCTOR_SPEC.md — AI-поиск генерирует тот же `FilterIR`,
что и ручной конструктор.

---

## 1. Принципы

1. **AI-слой не знает о фичах.** `AIProvider` — это generic-интерфейс «отправь промпт,
   получи ответ». Он не знает ни о фильтрах, ни о переводе, ни о чём-то ещё.
2. **Фичи не знают о провайдерах.** `AISearchService` работает через `AIProvider` и не
   знает, Chrome Prompt API это или облачный API.
3. **Privacy-first.** Для локального провайдера (Chrome Prompt API) данные не покидают
   устройство. Для будущих облачных — явный opt-in, минимизация передаваемых данных.

```
┌─────────────────────────────────────────────────────┐
│                    Фичи (потребители)               │
│                                                     │
│  ┌──────────────┐  ┌───────────────┐  ┌──────────┐  │
│  │ AI Search    │  │ AI Translate  │  │ AI ...   │  │
│  │ (→ FilterIR) │  │ (→ string)    │  │          │  │
│  └──────┬───────┘  └───────┬───────┘  └────┬─────┘  │
│         │                  │               │        │
│         └──────────┬───────┴───────────────┘        │
│                    ▼                                │
│         ┌─────────────────────┐                     │
│         │   AIProviderRegistry│                     │
│         │   (один активный)   │                     │
│         └──────────┬──────────┘                     │
│                    │                                │
│         ┌──────────▼──────────┐                     │
│         │     AIProvider      │  ← generic interface│
│         │  prompt() / json()  │                     │
│         └──────────┬──────────┘                     │
│                    │                                │
│    ┌───────────────┼───────────────────┐            │
│    ▼               ▼                   ▼            │
│ ┌────────┐  ┌────────────┐  ┌──────────────┐       │
│ │ Chrome │  │ Cloud BYOK │  │ Future       │       │
│ │ Prompt │  │ (v2)       │  │ providers    │       │
│ │ API    │  │            │  │              │       │
│ └────────┘  └────────────┘  └──────────────┘       │
└─────────────────────────────────────────────────────┘
```

---

## 2. Область (scope)

### v1 (этот спек):

- **AI Provider Layer:** generic-интерфейс, реестр, Chrome Prompt API провайдер.
- **AI Search:** первый потребитель — NL → FilterIR → конструктор фильтров.

### Вне scope (v1):

- Облачные провайдеры (BYOK) — только заложить интерфейс.
- AI-перевод, AI-суммаризация и другие фичи — только показать, как они используют
  тот же `AIProvider`.
- Многошаговый диалог / уточняющие вопросы модели.
- Голосовой ввод.

---

# Часть I. AI Provider Layer (generic)

## 3. Интерфейс AIProvider

```ts
type AIAvailability = 'unsupported' | 'downloadable' | 'downloading' | 'available';

interface PromptOptions {
  temperature?: number;         // 0.0–1.0, default зависит от провайдера
  maxTokens?: number;           // лимит ответа
  signal?: AbortSignal;         // отмена
}

interface AIProvider {
  /** Уникальный id провайдера */
  readonly id: string;                       // 'chrome-prompt-api'

  /** Человекочитаемое имя */
  readonly displayName: string;              // 'Chrome Built-in AI'

  /** Синхронная проверка наличия API в среде */
  isSupported(): boolean;

  /** Текущее состояние готовности модели */
  getAvailability(): Promise<AIAvailability>;

  /**
   * Подготовить модель к работе (скачивание, прогрев).
   * Для уже ready провайдера — no-op.
   * @param onProgress — callback 0..1 для UI прогресс-бара
   */
  ensureReady(onProgress?: (progress: number) => void): Promise<void>;

  /**
   * Отправить промпт, получить текстовый ответ.
   * Это ЕДИНСТВЕННЫЙ метод, который фичи используют для общения с моделью.
   * Никакой специфики фичи здесь нет.
   */
  prompt(systemPrompt: string, userMessage: string, options?: PromptOptions): Promise<string>;

  /**
   * Отправить промпт, получить структурированный JSON-ответ.
   * Провайдер использует JSON-schema constraint если доступен,
   * иначе добавляет инструкцию "respond with valid JSON" и парсит.
   * @param schema — JSON Schema для валидации/ограничения ответа
   */
  promptJSON<T = unknown>(
    systemPrompt: string,
    userMessage: string,
    schema: object,
    options?: PromptOptions
  ): Promise<T>;

  /** Освободить ресурсы (сессию, память) */
  dispose(): void;
}
```

### Почему `prompt()` + `promptJSON()`, а не `generateFilter()`

Провайдер — это **транспорт**. Он умеет доставить промпт модели и вернуть ответ.
Семантика запроса (поиск, перевод, суммаризация) — ответственность фичи-потребителя.

Примеры использования одного и того же интерфейса:

```ts
// AI Search: NL → FilterIR
const ir = await provider.promptJSON(searchSystemPrompt, userQuery, filterIRSchema);

// AI Translate: text → translated text
const translated = await provider.prompt(translateSystemPrompt, text);

// AI Summarize: work item description → summary
const summary = await provider.prompt(summarizeSystemPrompt, description);

// AI Title suggest: описание → title
const title = await provider.prompt(titleSuggestPrompt, description);
```

---

## 4. AIProviderRegistry

Управляет доступными провайдерами, выбирает активный.

```ts
interface AIProviderRegistry {
  /** Зарегистрировать провайдер */
  register(provider: AIProvider): void;

  /** Все зарегистрированные провайдеры */
  getAll(): AIProvider[];

  /**
   * Активный провайдер — первый available (по приоритету регистрации).
   * null если ни один не поддерживается.
   */
  getActive(): Promise<AIProvider | null>;

  /** Лучшее состояние доступности среди всех провайдеров */
  getBestAvailability(): Promise<AIAvailability>;

  /** Подписка на изменение доступности */
  onAvailabilityChange(callback: (availability: AIAvailability) => void): void;

  /** Освободить все провайдеры */
  disposeAll(): void;
}
```

Реализация: простой массив с приоритетом. В v1 один провайдер (Chrome Prompt API),
но интерфейс позволяет добавлять без изменения потребителей.

---

## 5. ChromePromptApiProvider

Первая и единственная реализация `AIProvider` в v1.

### 5.1 Обнаружение API

```ts
isSupported(): boolean {
  return typeof globalThis.LanguageModel !== 'undefined';
  // Точное имя объекта сверять с текущей документацией Chrome —
  // API в Origin Trial и может измениться.
}
```

### 5.2 Маппинг состояний

| Chrome API | Наш `AIAvailability` |
|---|---|
| `'available'` (или `'readily'`) | `'available'` |
| `'downloadable'` (или `'after-download'`) | `'downloadable'` |
| `'downloading'` | `'downloading'` |
| `'unavailable'` / `'no'` / отсутствует | `'unsupported'` |

> **Внимание:** Chrome Prompt API находится в Origin Trial, строковые константы могут
> измениться между версиями Chrome. Маппинг вынесен в отдельный справочник внутри
> провайдера для лёгкого обновления.

### 5.3 Управление сессией

```ts
class ChromePromptApiProvider implements AIProvider {
  private session: LanguageModelSession | null = null;

  async ensureReady(onProgress) {
    const avail = await LanguageModel.availability();
    if (avail === 'downloadable' || avail === 'after-download') {
      // Триггер скачивания с прогрессом
      this.session = await LanguageModel.create({
        monitor: (m) => m.addEventListener('downloadprogress', (e) => {
          onProgress?.(e.loaded / e.total);
        })
      });
    } else if (avail === 'available' || avail === 'readily') {
      this.session = await LanguageModel.create();
    }
  }

  async prompt(systemPrompt, userMessage, options) {
    if (!this.session) await this.ensureReady();
    // Chrome Prompt API: systemPrompt задаётся при создании сессии
    // или передаётся как часть messages. Конкретный API — сверять с документацией.
    return await this.session.prompt(userMessage, {
      systemPrompt,
      signal: options?.signal,
    });
  }

  async promptJSON(systemPrompt, userMessage, schema, options) {
    const augmentedPrompt = systemPrompt + '\n\nRespond ONLY with valid JSON matching this schema:\n' + JSON.stringify(schema);
    const raw = await this.prompt(augmentedPrompt, userMessage, options);
    return JSON.parse(extractJSON(raw));  // extractJSON удаляет markdown-обёртку, если есть
  }

  dispose() {
    this.session?.destroy();
    this.session = null;
  }
}
```

### 5.4 Ограничения Nano

- **Контекстное окно:** ~4096 токенов. Это жёсткий лимит, определяющий размер
  системного промпта + few-shot + пользовательского ввода.
- **Скорость:** ~10–30 tok/sec на средних устройствах.
- **Качество JSON:** Nano может генерировать невалидный JSON. Обязательна обработка
  (см. §9).

### 5.5 Manifest

```json
{
  "permissions": [..., "aiLanguageModelOriginTrial"],
  "trial_tokens": ["<origin-trial-token>"]
}
```

Точный формат — сверять с текущей документацией Chrome Extensions + Built-in AI.

---

## 6. Кнопка AI и состояния доступности (UI)

Кнопка AI в окне фильтров (рядом с «Advanced / Конструктор»):

| Состояние | Кнопка | Действие по клику |
|---|---|---|
| `unsupported` | Disabled + тултип «Требуется Chrome 130+ с поддержкой Built-in AI» | — |
| `downloadable` | Активна, бейдж «⬇» | Открыть диалог AI-поиска; при первом поиске — `ensureReady` с прогресс-баром |
| `downloading` | Активна, spinner/прогресс | Открыть диалог в режиме ожидания |
| `available` | Активна, иконка ✨ | Открыть диалог AI-поиска |

Доступность кешируется в рамках сессии, перепроверяется при открытии диалога.

---

# Часть II. AI Search (первый потребитель)

## 7. AISearchService

Сервис, связывающий AI Provider и Filter Constructor.

```ts
class AISearchService {
  constructor(
    private registry: AIProviderRegistry,
    private fieldRegistry: FieldRegistry,     // ← из FILTER_CONSTRUCTOR_SPEC
    private filterConstructor: FilterConstructor  // ← из FILTER_CONSTRUCTOR_SPEC
  ) {}

  /**
   * Основной метод: NL-запрос → FilterIR → конструктор
   *
   * Модель генерирует ТОТ ЖЕ FilterIR напрямую, без промежуточной
   * canonical-трансляции — потому что IR уже backend-agnostic.
   */
  async search(userQuery: string, options?: { signal?: AbortSignal }): Promise<SearchResult> {
    // 1. Получить активный провайдер
    const provider = await this.registry.getActive();
    if (!provider) throw new AIUnavailableError();

    // 2. Подготовить промпт со схемой полей из FieldRegistry
    const schema = buildFieldSchema(this.fieldRegistry);
    const systemPrompt = buildSearchSystemPrompt(schema);

    // 3. Отправить модели — она возвращает FilterIR напрямую
    const ir = await provider.promptJSON<FilterIR>(
      systemPrompt, userQuery, FILTER_IR_SCHEMA, options
    );

    // 4. Дообработка: добавить id/kind, резолвить имена людей
    const enriched = enrichIR(ir, this.fieldRegistry);

    // 5. Валидировать
    const validation = this.filterConstructor.validate(enriched);

    return {
      ir: enriched,
      warnings: validation.warnings,
    };
  }

  /**
   * Поиск + автоматическое заполнение конструктора
   */
  async searchAndApply(userQuery: string): Promise<void> {
    const result = await this.search(userQuery);
    this.filterConstructor.setIR(result.ir);
    // Конструктор отображает бабблы → пользователь ревьюит → применяет
  }
}
```

> **Ключевое упрощение:** поскольку Filter IR использует абстрактные ключи
> (`state`, `assignee`), модель генерирует тот же IR напрямую. Нет отдельного
> «canonical» формата, нет трансляции canonical → real. Один формат везде.

---

## 8. Схема полей для промпта

### 8.1 Почему не нужен отдельный canonical-слой

Filter IR уже использует **абстрактные ключи** (`state`, `assignee`, `priority`) —
см. FILTER_CONSTRUCTOR_SPEC §4. Это значит:

- Модель генерирует **тот же самый FilterIR**, который собирает пользователь руками.
- **Нет отдельного «canonical IR»** и нет трансляции canonical → real.
- Один формат, один валидатор, один BackendAdapter.

Нужна только **простая функция**, которая извлекает из FieldRegistry схему полей
для вставки в системный промпт.

### 8.2 buildFieldSchema()

```ts
/**
 * Извлекает схему полей из FieldRegistry для вставки в промпт.
 * Никакой трансляции — ключи из FieldRegistry уже абстрактные.
 */
function buildFieldSchema(registry: FieldRegistry): FieldSchemaForPrompt {
  return {
    fields: registry.getFilterable().map(field => ({
      key: field.key,              // "state" — тот же ключ, что в IR
      type: field.type,            // "string", "integer", "identity"
      displayName: field.displayName,
      values: field.values,        // enum-значения
      operators: field.operators,
    })),
  };
}
```

### 8.3 Люди (PII)

Директория пользователей **НЕ** передаётся модели.

- `@me` — модель возвращает как есть, BackendAdapter резолвит.
- «assigned to John» — модель возвращает `"John"` как строку, `enrichIR()` резолвит
  через `BackendAdapter.resolveIdentity()` (fuzzy-matching по загруженному списку).
- Если совпадение не найдено — предупреждение пользователю в бабблах.

### 8.4 Тримминг схемы

Контекстное окно Nano ~4K токенов. Бюджет:

| Компонент | ~Токены |
|---|---|
| Системный промпт + инструкции | ~500 |
| Few-shot примеры (4–6) | ~800 |
| Схема полей | ~300–1500 (зависит от числа полей) |
| Пользовательский ввод | ~100–500 |
| Буфер для ответа | ~500 |
| **Итого** | **~2200–3300** |

Правила тримминга:
1. Всегда включать стандартные поля (~15 полей).
2. Кастомные поля — top-N по частоте использования в текущих work items.
3. Enum-значения — если >10, включать только используемые в проекте.
4. Предупреждение в лог, если схема обрезана.

---

## 9. Системный промпт и few-shot

### 9.1 Структура промпта

```
SYSTEM PROMPT:
  1. Роль: "You are a work item search assistant..."
  2. Задача: "Convert the user's natural language query into a JSON filter."
  3. Формат ответа: FilterIR JSON schema (тот же формат, что и ручной конструктор)
  4. Схема полей из FieldRegistry: {fields: [...]}
  5. Словарь операторов: =, <>, >, <, IN, CONTAINS, UNDER, WAS EVER, ...
  6. Макросы: @me, @today, @today-N, @currentIteration
  7. Few-shot примеры

USER MESSAGE:
  Запрос пользователя на любом языке
```

### 9.2 Ответ модели = FilterIR

Модель возвращает **тот же самый FilterIR**, что собирает пользователь
руками в конструкторе. Нет отдельного «canonical» формата — IR уже использует
абстрактные ключи:

```json
{
  "where": {
    "logic": "AND",
    "rules": [
      { "field": "status", "op": "=", "value": "active" },
      { "field": "assignee", "op": "=", "value": "@me" }
    ]
  },
  "orderBy": [{ "field": "priority", "dir": "asc" }]
}
```

> `id` и `kind` для бабблов не требуются на выходе от ИИ — они добавляются при вызове `enrichIR()`.

### 9.3 Few-shot примеры (абстрактная лексика — стабильны)

```
User: "мои активные баги"
→ { "where": { "logic": "AND", "rules": [
      { "field": "type", "op": "=", "value": "bug" },
      { "field": "status", "op": "=", "value": "active" },
      { "field": "assignee", "op": "=", "value": "@me" }
    ] } }

User: "P1 tasks created in last week"
→ { "where": { "logic": "AND", "rules": [
      { "field": "type", "op": "=", "value": "task" },
      { "field": "priority", "op": "=", "value": 1 },
      { "field": "created_date", "op": ">", "value": "@today-7" }
    ] } }

User: "items with tag 'urgent' or priority 1"
→ { "where": { "logic": "OR", "rules": [
      { "field": "tags", "op": "CONTAINS", "value": "urgent" },
      { "field": "priority", "op": "=", "value": 1 }
    ] } }
```

---

## 10. Поток: от ввода до результата

```
1. Пользователь нажимает кнопку AI ✨
2. Открывается диалог AI-поиска:
   - Поле свободного ввода (multiline, ~800 символов мягкий лимит)
   - Плейсхолдер с примером: "Find active bugs assigned to me"
   - Кнопка «Search» (disabled при пустом вводе)

3. Пользователь вводит запрос, нажимает «Search»
4. Состояние: generating (спиннер)
   - Если модель downloadable → прогресс скачивания → затем генерация
   - AISearchService.search(userQuery) вызывается

5. Модель возвращает FilterIR
6. AISearchService:
   a. Парсит JSON (невалидный → 1 auto-repair попытка → ошибка)
   b. Обогащает (enrichIR), добавляя id/kind и резолвя людей
   c. Валидирует через filterConstructor.validate()
   d. Предупреждения (отброшенные условия) → показать пользователю

7. filterConstructor.setIR(enrichedIR) → бабблы появляются в конструкторе
8. Пользователь видит бабблы:
   - Может отредактировать (сменить поле, оператор, значение)
   - Может удалить отдельные условия
   - Может добавить условия вручную
   - Видит предупреждения (если что-то не применилось)

9. Пользователь нажимает «Apply» → фильтр применяется к основному экрану
   ИЛИ «Preview» → результаты в отдельной панели → «Apply» / «Cancel»
   ИЛИ «Cancel» → закрыть без изменений
```

---

## 11. Обработка ошибок

| Ситуация | Действие |
|---|---|
| Провайдер не поддерживается | Кнопка disabled + тултип |
| Модель требует загрузки | Прогресс-бар, затем генерация |
| Модель вернула невалидный JSON | 1 auto-repair (повторный вызов с текстом ошибки) → сообщение об ошибке |
| Модель выдумала несуществующее поле | Условие отбрасывается, пользователь видит предупреждение |
| Модель выдумала несуществующее значение enum | Нормализация (fuzzy match) или отбрасывание с предупреждением |
| Человек не найден по имени | Баббл с предупреждением «Не удалось найти пользователя "John"» |
| Пустой ввод | Кнопка «Search» disabled |
| Нет результатов | Подсказка «Попробуйте смягчить условия» |
| Слишком много результатов | Подсказка «Попробуйте уточнить запрос» |
| Сбой REST-запроса | Ошибка с кнопкой «Повторить» |
| Таймаут модели | Ошибка «Модель не ответила вовремя» + «Повторить» |

---

## 12. Приватность

### Локальный провайдер (Chrome Prompt API)

- Инференс полностью локальный, данные не покидают устройство.
- Модели передаётся:
  - Текст запроса пользователя (он сам его ввёл).
  - Схема полей (абстрактные ключи, типы, значения enum).
- Модели **НЕ** передаётся:
  - Содержимое work items.
  - Реальные reference names ADO.
  - Внутренняя структура проекта.
  - Список пользователей / PII.

### Будущие облачные провайдеры (вне v1)

- Обязательный **явный opt-in** с предупреждением: «Ваш запрос будет отправлен на
  сервер [провайдер]. Содержимое work items не передаётся.»
- Абстрактная схема + локальный резолв людей дают реальный приватностный выигрыш:
  наружу уходят только нейтральные ключи + запрос.
- Настройка в UI: выбор провайдера, ввод API key, включение/выключение.

### Границы (честно)

Семантика полей не скрывается (модель должна её понимать: `status`, `priority`).
Скрываются: вендорные идентификаторы (`System.State`), внутренняя структура (`Microsoft.
VSTS.Common.Priority`), PII (имена, email). Для локального провайдера выигрыша по
приватности нет — польза в развязке с бэкендом.

---

## 13. Диалог AI-поиска (UI)

### 13.1 Компоненты

- **Заголовок:** «AI Search» + иконка ✨
- **Поле ввода:** multiline, мягкий лимит ~800 символов, живой счётчик, жёсткий лимит ~1500.
  Плейсхолдер: «Describe what you're looking for...»
- **Кнопка «Search»:** disabled при пустом вводе и во время генерации.
- **Область результата:** бабблы конструктора (FILTER_CONSTRUCTOR_SPEC §8).
- **Предупреждения:** жёлтые бейджи на отброшенных/нормализованных условиях.
- **Действия:**
  - «Apply» — применить фильтр к основному экрану.
  - «Preview» — показать результаты в отдельной панели.
  - «Cancel» — закрыть без изменений.
- **Состояния:** `idle` → `generating` → `result` / `error`.

### 13.2 Повторный запрос

Пользователь может изменить текст и нажать «Search» снова — бабблы обновятся.
Или отредактировать бабблы вручную после AI-генерации.

---

# Часть III. Будущие AI-фичи (эскиз)

Эти фичи **не в scope v1**, но архитектура AI Provider Layer их поддерживает.

## 14. AI Translate (пример будущей фичи)

```ts
class AITranslateService {
  constructor(private registry: AIProviderRegistry) {}

  async translate(text: string, targetLang: string): Promise<string> {
    const provider = await this.registry.getActive();
    if (!provider) throw new AIUnavailableError();

    const systemPrompt = `You are a translator. Translate the following text to ${targetLang}. Return ONLY the translated text, nothing else.`;
    return provider.prompt(systemPrompt, text);
  }
}
```

Интеграция: кнопка «Translate» в карточке work item рядом с description.

## 15. AI Summarize (пример)

```ts
class AISummarizeService {
  constructor(private registry: AIProviderRegistry) {}

  async summarize(description: string): Promise<string> {
    const provider = await this.registry.getActive();
    const systemPrompt = 'Summarize the following work item description in 2-3 sentences.';
    return provider.prompt(systemPrompt, description);
  }
}
```

## 16. AI Title Suggest (пример)

```ts
class AITitleSuggestService {
  constructor(private registry: AIProviderRegistry) {}

  async suggest(description: string): Promise<string[]> {
    const provider = await this.registry.getActive();
    const systemPrompt = 'Suggest 3 concise titles for a work item with the following description. Return as JSON array of strings.';
    return provider.promptJSON<string[]>(systemPrompt, description, { type: 'array', items: { type: 'string' } });
  }
}
```

Все три фичи используют **один и тот же** `AIProvider` — нет дублирования инфраструктуры.

---

## 17. Файлы и изменения

### Новые файлы

| Файл | Ответственность |
|---|---|
| `ai/ai-provider.js` | `AIProvider` интерфейс (JSDoc), `AIProviderRegistry` |
| `ai/chrome-prompt-provider.js` | `ChromePromptApiProvider` реализация |
| `ai/ai-search-service.js` | `AISearchService` — NL → FilterIR |
| `ai/canonical-schema.js` | `CanonicalSchemaAdapter` — маппинг canonical ↔ real |
| `ai/prompts/search-prompt.js` | Системный промпт + few-shot для поиска |
| `components/ai-search-dialog.js` | UI диалога AI-поиска |
| `ai/ai-search-dialog.css` | Стили диалога |

### Изменяемые файлы

| Файл | Изменения |
|---|---|
| `manifest.json` | Добавить `aiLanguageModelOriginTrial` permission |
| `app.js` | Кнопка AI ✨, инициализация `AIProviderRegistry`, интеграция диалога |
| `index.html` | Подключение AI-модулей |
| `app.css` | Стили кнопки AI, стейты доступности |

---

## 18. Поэтапный план

### Фаза 1: AI Provider Layer (generic)

- `AIProvider` интерфейс + `AIProviderRegistry`.
- `ChromePromptApiProvider` с `prompt()` / `promptJSON()`.
- Тесты: mock-провайдер, unit-тесты registry.
- Manifest: permissions.
- **Результат:** универсальный AI-слой, готовый к любым фичам.

### Фаза 2: AI Search Service

- `CanonicalSchemaAdapter` (стандартные поля, без кастомных в v1).
- `AISearchService` с промптом и few-shot.
- Auto-repair для невалидного JSON.
- **Зависимость:** Filter Constructor (FILTER_CONSTRUCTOR_SPEC) — должен быть готов
  хотя бы IR + validator.

### Фаза 3: AI Search UI

- Кнопка AI в окне фильтров.
- Диалог AI-поиска.
- Интеграция с bubble editor: `setIR()` → бабблы.
- Preview и Apply flow.
- **Зависимость:** Filter Constructor UI (bubble editor).

### Фаза 4: Полировка

- Тримминг схемы для проектов с множеством кастомных полей.
- Fuzzy-matching для identity и enum-значений.
- Телеметрия (локальная): счётчики запросов, % успешных парсингов.

---

## 19. Открытые вопросы

- **Сессия Chrome Prompt API:** создавать сессию один раз и переиспользовать или создавать
  на каждый запрос? (Зависит от API — может быть ограничение на время жизни сессии.)
- **Лимит ввода:** предложено ~800 символов (мягкий). Уточнить после тестов с реальной
  моделью Nano.
- **Retry-стратегия:** при невалидном JSON — 1 auto-repair. Достаточно ли? Или нужен
  fallback (убрать JSON constraint и парсить свободный текст)?
- **Streaming:** Chrome Prompt API поддерживает streaming. Нужен ли для AI Search?
  (Скорее нет — фильтр маленький. Но для будущих фич типа перевода — да.)
- **Совместимость с будущими провайдерами:** достаточно ли `prompt()` + `promptJSON()`?
  Возможно, понадобятся `promptStream()`, `promptWithImages()` и т.д. — добавлять
  по мере необходимости, не перепроектировать.
