# Техническое задание: Рефакторинг кода ADO Atlas (модульная структура)

Разбиение монолитов `app.js` (8.9k строк), `api.js` (1.85k) и `app.css` (2.1k) на модули.
Целевая архитектура — **namespaced IIFE-модули** под единым глобальным `window.App`
(тот же паттерн, что уже используют `components/*` и `ai/*`), с сохранением текущей
**no-bundler** схемы (классические `<script>` в общем глобальном скоупе, порядок загрузки
в `index.html`, защита через `tools/check-globals.js`).

---

## 1. Цели и принципы

- **Целевое состояние:** каждый модуль — IIFE, экспортирует свой публичный API в `window.App.<area>`;
  общее изменяемое состояние — в едином `App.state`; константы — в `App.const`.
- **Без бандлера.** Сохраняем классические `<script>`, порядок в `index.html`, `check-globals` как сеть безопасности.
- **Поведение не меняется.** Рефакторинг — это перемещение и переименование, без правок логики.
  Никогда не «переносим + меняем логику» в одном шаге.
- **Фазировано и проверяемо.** Каждый шаг — один модуль, после него зелёный гейт
  (`check-globals` + `npm test` + ручной smoke). Один коммит = один модуль (легко ревьюить и откатывать).
- **Минимум churn там, где он не даёт пользы.** `$` (alias `getElementById`) и объект `api`
  остаются глобальными (см. §4, §6) — это уже де-факто пространства имён.

---

## 2. Архитектура пространства имён `App`

Единый глобальный объект `window.App`, создаётся первым скриптом-бутстрапом.

```js
// app/namespace.js — грузится ПЕРВЫМ среди app/*
window.App = window.App || {};
// Сверх-горячий alias оставляем глобальным, чтобы не трогать тысячи вызовов $('id'):
window.$ = window.$ || (id => document.getElementById(id));
```

Каждый модуль:
```js
// app/view-tree.js
(function (App) {
  'use strict';
  const S = App.state, C = App.const;          // короткие алиасы
  function render() { /* … S.cy … */ App.views.refreshLegend(); }
  function wire()   { /* … */ }
  App.tree = { render, wire };                 // только ПУБЛИЧНЫЙ API
})(window.App);
```

Правила:
- **Внутримодульные** вызовы — локальные функции (приватные, не в `App`).
- **Межмодульные** вызовы — через `App.<area>.<fn>()`, резолвятся в момент вызова →
  порядок загрузки feature-модулей между собой не важен (важно лишь: `namespace → const → state`
  раньше всех, `boot` — последним).
- **Состояние** — только через `App.state.*` (после Фазы 3). Никаких bare-глобалов.
- В `App.<area>` кладём минимум — то, что реально зовут другие модули / boot.

### Карта под-namespace'ов
`App.const`, `App.state`, `App.loading`, `App.filters`, `App.tree`, `App.graph`, `App.board`,
`App.sprintDetail`, `App.timeline`, `App.views`, `App.side`, `App.editor`, `App.attachments`,
`App.deps`, `App.activity`, `App.undo`, `App.create`, `App.sprint`, `App.types`, `App.export`,
`App.settings`, `App.setup`, `App.layout`, `App.layoutBuilder`, `App.init`, `App.boot`.

---

## 3. Разбиение `app.js` → `app/` (~24 модуля)

| Файл | Namespace | Ответственность | Исходные строки |
|---|---|---|---|
| `app/namespace.js` | `App`, `$` | bootstrap глобала + alias | — |
| `app/const.js` | `App.const` | TYPE/PRIO/STATE-цвета, STATE_ORDER, TYPES, `tyColor/prioColor/stateColor` | 15–54 |
| `app/state.js` | `App.state` | всё изменяемое состояние (cy, mode, store, bulkSel, токены, project-данные, ссылки на редакторы, badge-стейт) | 55–342 (разбросано) |
| `app/loading.js` | `App.loading` | refcounted индикатор загрузки | 491–517 |
| `app/filters.js` | `App.filters` | данные чип-фильтров (`FILTERS`) + apply/wiring | 518–735 |
| `app/view-tree.js` | `App.tree` | дерево + bulk-select + drag-reparent | 736–1374 |
| `app/view-graph.js` | `App.graph` | граф + drag-стаб зависимостей | 1375–1744 |
| `app/view-board.js` | `App.board` | доска (спринты) + drag карточек | 1745–2005 |
| `app/view-sprint.js` | `App.sprintDetail` | детальный спринт (Gantt) | 2006–2100 |
| `app/view-timeline.js` | `App.timeline` | проектный таймлайн | 2101–2232 |
| `app/views.js` | `App.views` | переключение режимов/refresh, `VIEW_HELP`/легенда, панель бейджей | 2233–2439 |
| `app/side-panel.js` | `App.side` | `openItem`, заголовок сайдбара, ядро редактора айтема | 2440–2512, ~3081+ |
| `app/editor-attachments.js` | `App.attachments` | вложения, paste/drop, @mention-typeahead, fullscreen | 2513–2810 |
| `app/dependencies.js` | `App.deps` | связи Blocked-by/Blocks (сайдбар + граф) | 4090–4191 |
| `app/undo-redo.js` | `App.undo` | стек undo/redo | 4192–4522 |
| `app/activity.js` | `App.activity` | реакции, инлайн-правки, комментарии + история | 4523–5286 |
| `app/item-create.js` | `App.create` | создание айтема с нуля | 5287–5335 |
| `app/sprint-edit.js` | `App.sprint` | создание/редактирование спринта | 5336–5840 |
| `app/types.js` | `App.types` | типы рабочих элементов из ADO | 5841–5885 |
| `app/export.js` | `App.export` | экспорт текущего вида (CSV/JSON) | 5886–5906 |
| `app/settings.js` | `App.settings` | тема/auto-refresh, snapshot-кэш, command palette, UI scale | 5907–6044, 7958 |
| `app/setup.js` | `App.setup` | setup-модал, пикер org/project, PAT-countdown, pre-PAT wiring | 6045–6315 |
| `app/layout-persist.js` | `App.layout` | side/bulk/bar layout load·save·apply, `updateSideGroupsForType` | 6316–7051 |
| `app/layout-builder.js` | `App.layoutBuilder` | визуальный конструктор раскладки (toolbox/canvas/dropzones) + табы | 7052–7957 |
| `app/init.js` | `App.init` | `initialBoot` + wiring-хелперы (`loadIdentity/loadFilterData/…`) | 7958–8773 |
| `app/boot.js` | `App.boot` | `DOMContentLoaded`, глобальный paste-dispatcher, debug-хуки | 8774–8867 |

**Под-рефакторинг (внутри Фазы 2):** тело `initialBoot` (~700 строк) разбить на
`wireToolbar / wireModes / wireKeyboard / wireSettings / wireSidePanel` — внутри `app/init.js`.

---

## 4. Разбиение `api.js` → `api/`

`api.js` **уже** экспортирует глобальный объект `api` (app.js зовёт `api.item()`, `api.me()`, `api.getConfig()`),
т.е. фасад готов. Разбиваем внутреннюю реализацию на файлы, которые наполняют общий `api`
(через `Api` internal namespace или достройку одного объекта), сохраняя `api.*` снаружи без изменений.

| Файл | Ответственность |
|---|---|
| `api/core.js` | базовый fetch-врапер, заголовки авторизации, чтение/запись config, `AdoLib`-импорт |
| `api/auth.js` | PAT + OAuth (`oauthSignIn`, обмен токенов, refresh) |
| `api/wiql.js` | список/запросы (WIQL, `list`, FIELD_REGISTRY, `buildClauses`-обвязка) |
| `api/items.js` | CRUD/patch рабочих элементов, batch |
| `api/fields.js` | реестр полей, метаданные, типы, состояния |
| `api/attachments.js` | загрузка/привязка вложений |
| `api/activity.js` | комментарии + история изменений |

Требует такого же banner-mapping прохода, как сделан для app.js (зафиксировать точные диапазоны строк перед резкой).

---

## 5. Разбиение `app.css` → несколько `<link>`

CSS не имеет скоуп-/порядковых ловушек → самый безопасный сплит. Грузим несколькими `<link>`
(или каталог `css/`). Сохранить порядок: сначала база/переменные.

`css/base.css` (reset + theme-переменные, light/dark), `css/toolbar.css`, `css/tree.css`,
`css/graph.css`, `css/board.css`, `css/timeline.css`, `css/side-panel.css`, `css/modals.css`,
`css/filters.css`, `css/activity.css`.

> Светлая/тёмная тема: переменные темы остаются в `base.css`, остальные файлы используют только
> CSS-переменные (см. правило «always theme-dependent styling»).

---

## 6. Фазированный план миграции (каждый шаг — зелёный гейт)

**Гейт после каждого шага:** `node tools/check-globals.js` + `node tests/lib.test.js` +
`node tests/ai.test.js` + ручной smoke (открыть расширение, прокликать tree/graph/board/timeline,
сайд-панель, фильтры, настройки). Один коммит на модуль.

### Фаза 0 — Каркас
1. `app/namespace.js` (`window.App={}`, глобальный `$`). Подключить ПЕРВЫМ среди app-скриптов в `index.html`.
2. `app/const.js` — перенести константы/цвета (15–54) в `App.const`, заменить ссылки в app.js (`tyColor`→`App.const.tyColor` и т.д.).
3. `app/state-globals.js` — **временно** оставить bare-`let` глобалы как есть, просто вынести блок 55–342 в отдельный файл (без смены имён). Цель — расцепить файлы, не трогая ссылки на состояние.
4. Добавить новые файлы в `tools/check-globals.js` и `build.ps1` ($dirs += `app`). Зелёный гейт.

### Фаза 1 — Вынос leaf-модулей в `App.*` (состояние пока bare-глобальное)
Двигаемся от самых независимых к зависимым. Для каждого: перенести функции секции в `app/<name>.js`
как `App.<name> = {…}`, переписать **межмодульные** call-sites на `App.<name>.fn()`, локальные — оставить.
Состояние всё ещё читается как bare-глобал из `state-globals.js` (общий скоуп) → **churn по состоянию нулевой**.

Порядок: `export → types → undo → loading → timeline → graph → tree → board → sprintDetail →
activity → deps → attachments → side → create → sprint → filters → views → settings → setup →
layout → layoutBuilder`. Гейт после каждого.

### Фаза 2 — `init` и `boot`
Вынести `app/init.js` и `app/boot.js`; разложить тело `initialBoot` на `wire*`-хелперы. Гейт.

### Фаза 3 — Централизация состояния в `App.state`
Превратить `state-globals.js` → `app/state.js` (`App.state = {…}`). Переписать ссылки на состояние
**помодульно** (ограниченный объём на файл): `cy`→`App.state.cy` (или локальный `const S=App.state; S.cy`).
Гейт после каждого модуля. Это самая аккуратная фаза — делать по одному файлу.

### Фаза 4 — `api.js → api/`
Banner-mapping `api.js` → резать по §4, фасад `api.*` снаружи неизменен. Гейт (тесты гоняют `api`-смежные пути).

### Фаза 5 — `app.css → css/`
Разрезать по §5, обновить `<link>` в `index.html`, `build.ps1` ($files/css-каталог). Визуальный smoke (light+dark).

---

## 7. Гайки no-bundler (что обязательно поддержать на каждом шаге)

- **Порядок в `index.html`:** `namespace → const → state(-globals) → loading → leaf-views/features → layout → init → boot`. Критичен только для кода, исполняемого на верхнем уровне при загрузке; функции зовутся после boot.
- **`tools/check-globals.js`:** добавлять КАЖДЫЙ новый `app/*.js` и `api/*.js` в список. Инструмент компилирует всё как единый скоуп и валит сборку при дубле top-level имени — это и есть гарантия чистоты сплита.
- **`build.ps1`:** `$dirs += 'app','api','css'` (или css в `$files`). Каталоги копируются рекурсивно.
- **IIFE без top-level коллизий:** все приватные имена внутри IIFE; в общий скоуп торчат только `App`, `$`, `api`, `AdoLib` (как сейчас).
- **При выносе модуля конвертировать ОБА вида ссылок на его публичные функции:** и вызовы `fn(...)`, и ссылки-значения (колбэки): `onclick=fn`, `addEventListener('x',fn)`, `.then(fn)`, `setInterval(fn,…)`. Регексп `fn\(` ловит только вызовы — ссылки-значения (`(?<![.\w])fn(?![\w(])`) надо конвертировать отдельно, иначе `ReferenceError` в рантайме (статический `check-globals` это НЕ ловит — только smoke). Пропускать строки-комментарии.
- **check-globals не ловит рантайм-ошибки** (отсутствующая bare-ссылка, TDZ, порядок). После каждого модуля — обязательно ручной smoke ключевых путей, особенно колбэков/обработчиков.
- **i18n совместимость:** модули, рендерящие DOM, продолжают звать `window.i18n.t()` / ставить `data-i18n*` и `window.i18n.applyDOM(root)` (без изменений).

---

## 8. Риски и митигация

- **Состояние (Фаза 3)** — главный риск: ссылка пропущена → `undefined`. Митигация: помодульно, после каждого `check-globals`+тесты+smoke; grep остаточных bare-имён.
- **`initialBoot` (700 строк)** — плотное переплетение wiring; резать по «что что включает», не по строкам вслепую.
- **Скрытые порядковые зависимости** top-level кода — выявляются падением boot на smoke; держать boot строго последним.
- **Регекс-трансформации** — только для поиска call-sites; правки ревьюить, не применять вслепую (риск ложных совпадений по подстроке).
- **Объём** — большой; разнести по нескольким сессиям, один модуль = один коммит = один откат.

---

## 9. Открытые вопросы

- `app/` плоско или с под-папками (`app/views/`, `app/editor/`)? Предлагаю плоско — проще порядок в `index.html`.
- `$` глобальный или `App.$`? Предлагаю оставить глобальным (минус тысячи правок).
- Делать ли Фазу 3 (централизация состояния) сразу или жить с `state-globals.js` какое-то время? Предлагаю довести до конца ради чистых границ.
