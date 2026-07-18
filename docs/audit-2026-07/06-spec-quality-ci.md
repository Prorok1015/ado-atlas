# Спецификация: тесты, CI, типизация

Покрывает: C09, C10, C21, C29, C42, C44.

## Суть проблемы

Гейт качества **написан** — `check-globals` + `check-i18n-keys` + `check-prefs` +
три тестовых файла. Это больше, чем есть у большинства соло-проектов.

Но у него две дыры, и вместе они делают его почти декоративным:

1. **Его ничто не запускает.** `.github/` не существует, git-хуков нет.
2. **Один из тестов врёт.** `ai.test.js` печатает «passed» до того, как выполнятся ассерты.

То есть можно закоммитить сломанный код, собрать `dist/*.zip` и **отправить его в Chrome
Web Store**, ни разу не прогнав тесты — а если и прогнать, зелёный результат ничего не гарантирует.

---

## Q1. Починить лгущий тест-раннер · high · 1 час · **делать первым**

**Где:** `tests/ai.test.js:32-41`

```js
function test(name, fn) {
  try { fn(); pass++; console.log('ok', name); }   // ← fn() вызывается СИНХРОННО
  catch (e) { fail++; ... }
}
```

При этом **17 из 19 тестов объявлены `async`**:
```js
test('enrichIR resolves identities', async () => {
  const r = await svc.enrichIR(...);
  assert.equal(r.assignee, '...');      // ← этот assert выполнится ПОСЛЕ pass++
});
```

Для async-функции `fn()` возвращает **pending Promise**. `try/catch` завершается мгновенно,
`pass++` инкрементируется, «ok» печатается — **до того, как ассерты вообще выполнились**.
Упавший `assert` улетает в `unhandledRejection` и **не попадает в `fail++`**.

Финал — `setTimeout(() => { if (fail > 0) process.exit(1); }, 100)` — гонка: 100 мс может
не хватить, и процесс выйдет с кодом 0.

**Вывод: «19 passed, 0 failed» — недостоверно.** Самая сложная часть проекта (AI-пайплайн)
на деле не проверяется. Регрессии там проходят незамеченными.

**Сделать:**
```js
const pending = [];
function test(name, fn) {
  pending.push((async () => {
    try { await fn(); pass++; console.log('ok', name); }
    catch (e) { fail++; console.error('FAIL', name, e.message); }
  })());
}
// в конце файла:
await Promise.all(pending);
if (fail > 0) process.exit(1);
```
Убрать `setTimeout(100)`. Альтернатива — перейти на встроенный `node --test` (нулевые
зависимости, это уже есть в Node).

**Критерий приёмки:** намеренно сломанный assert в async-тесте роняет прогон с кодом 1.

Это **первое, что надо сделать во всём аудите** — пока раннер врёт, любая другая работа
над тестами бессмысленна.

---

## Q2. CI · high · 30 минут · огромный рычаг

**Где:** `.github/` — **не существует**.

Инфраструктуру писать **не нужно** — гейт уже готов, его просто некому запускать.
Плюс в WSL `npm` резолвится в Windows-npm через маунт, и `ARCHITECTURE.md:108-111`
описывает целый обходной ритуал с прямым вызовом `node.exe`. Локальный прогон **хрупкий**,
и легко получить ложно-зелёный.

CI решает и это: на `ubuntu-latest` всё запускается нативно.

```yaml
# .github/workflows/ci.yml
name: CI
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '22' }
      - run: npm test          # zero deps — ничего ставить не нужно
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '22' }
      - run: npm run build
      - uses: actions/upload-artifact@v4
        with: { name: extension, path: dist/*.zip }
```

Второй job важен не меньше первого: он **проверяет, что сборка вообще собирается**,
и складывает готовый zip артефактом — то есть в стор уезжает ровно то, что прошло тесты.

Дополнительно — дешёвый pre-commit hook с `npm test` локально.

**Критерий приёмки:** PR с падающим тестом виден красным; артефакт сборки скачивается из CI.

---

## Q3. Покрыть денежную логику · high · 1 день

**Где:** `tests/*` vs `src/components/entitlement-manager.js`

Сейчас тестами покрыты **только чистые функции** (`lib.js`, `filter-manager`, `prefs`,
частично `ai/*` и `mapWorkItem`). Grep по `entitlement|paywall|pro-features|license`
в `tests/` → **ноль**.

То есть **~20 000 строк** stateful/DOM-кода — `filter-builder-modal`, `layout`, `side-panel`,
`editor`, `bulk`, `undo/redo`, `board/tree/graph/timeline`, `endpoints`, `background.js` —
и **весь денежный гейт** держатся исключительно на ручном Chrome-смоуке.

**Начать с `EntitlementManager.isPro()`.** Это самая выгодная точка входа, потому что:
- она **почти чистая** — вся логика это `Date.now()` и объект состояния;
- ей нужен только инъектируемый `state` и `now`, никакого Chrome;
- это **деньги** — здесь ошибка стоит дороже всего;
- сейчас у неё **ноль** тестов, при том что в ней есть неочевидный grace-период.

```js
// tests/entitlement.test.js — что покрыть
isPro({tier:'free'})                                        → false
isPro({tier:'pro', status:'active'})                        → true
isPro({tier:'pro', status:'past_due', last_validated_at: now - 3*DAY})  → true   // grace
isPro({tier:'pro', status:'past_due', last_validated_at: now - 8*DAY})  → false  // grace истёк
isPro({_devForcePro:true})                                  → true
gate('x') при isPro()=true                                  → true, пейволл НЕ открыт
```

Последний кейс — прямая регрессия на [C14](02-findings-catalog.md), главный блокер выручки.

**Дальше — инкрементально:** при каждом касании stateful-модуля выносить из него чистый
кусок в тестируемую функцию. Не пытаться покрыть 20k строк разом — это не окупится.
Приоритет — то, где ошибка тихая: расчёты дат, компиляция FilterIR, math аналитики.

**Критерий приёмки:** `npm test` включает `entitlement.test.js`; все шесть кейсов зелёные.

---

## Q4. Типизация без TypeScript · medium · 1 день на старт

**Где:** нет `jsconfig`/`tsconfig`, нет `// @ts-check`, нет `@typedef` на ~24k строк.
Форма `App.state` описана **только комментарием** (`state-globals.js:10-23`).

Именно тот класс ошибок, о котором предупреждает сам `ARCHITECTURE.md` в «Hard lessons»
(опечатка в `App.state.*`, битая bare-ссылка, TDZ, неверный SVG-атрибут), **не ловится
ничем** до рантайма в Chrome. Единственная защита — ручной smoke.

**Переписывать на TypeScript не нужно.** Достаточно:

```jsonc
// jsconfig.json — типы БЕЗ смены языка и без build-step
{
  "compilerOptions": {
    "checkJs": true,
    "allowJs": true,
    "noEmit": true,
    "target": "ES2022",
    "lib": ["ES2022", "DOM"]
  },
  "include": ["src/**/*.js", "background.js"]
}
```

Дальше — **постепенно**: `// @ts-check` в шапку ядровых файлов (начать с `lib.js`,
`state-globals.js`, `entitlement-manager.js`), `/** @typedef */` на форму `App.state`
и `REGISTRY`. Файл за файлом, а не всё сразу. Редактор начнёт ловить опечатки в тот же день.

**Плюс ESLint** — он здесь ценнее типов, потому что shared-global-scope это его родная тема:
```jsonc
{
  "env": { "browser": true, "webextensions": true },
  "globals": { "App": "writable", "api": "readonly", "AdoLib": "readonly",
               "$": "readonly", "i18n": "readonly" },
  "rules": { "no-undef": "error", "no-unused-vars": "error" }
}
```
`no-undef` с явным allow-list глобалов — это ровно тот гейт, которого не хватает: он ловит
и опечатки, и забытые bare-ссылки, и файл, не подключённый в `index.html` (символ окажется
не определён).

**Критерий приёмки:** `npx eslint src/` проходит; `no-undef` включён; CI гоняет линт.

---

## Q5. Единый рубильник стадии премиума · low · 2 часа · (UNVERIFIED)

Флаги и заглушки размазаны по **пяти+** файлам:
```js
hosted-cloud-provider.js:13   const BACKEND_LIVE = false;
background.js:208             sendResponse({ error: 'Hosted AI proxy is not available yet.' });
entitlement-manager.js:62     activate() { throw new Error('...coming soon'); }
premium-paywall.js:132-139    блок 'Coming Soon' + disabled кнопка
pro-features.js               CATALOG: status:'planned'
```

Переход в Stage 2 потребует синхронно править **все пять** и надеяться на ручной smoke.
Забыл один — получил несогласованное состояние (например, касса включилась, а провайдер
всё ещё рапортует «недоступно»).

**Сделать:** один конфиг-флаг `PREMIUM_STAGE`, от которого зависят все перечисленные точки.
Один рубильник — одно место для ошибки.

---

## Q6. Гигиена репозитория · low · 1 час · (UNVERIFIED)

- **Нет `CHANGELOG.md`.** `package.json:3` и `manifest.json` согласованы на `1.3.0` (это плюс),
  но что именно уехало в каждую версию Web Store — **не зафиксировано нигде**. Откаты и
  коммуникация с пользователями («в какой версии починили?») становятся угадайкой.
  → Завести `CHANGELOG.md` (Keep a Changelog), черновик генерировать из conventional-commits —
  они в проекте уже соблюдаются, судя по git log.
- **`scratch/test.js`** — мёртвый скрипт: `require('../lib.js')`, но `lib.js` давно переехал
  в `src/core/lib.js`. Запустится с ошибкой, дезориентирует. → Удалить или починить путь.
  (`scratch/` в `.gitignore` и в билд не попадает — то есть вреда нет, но и смысла тоже.)

---

## Порядок работ

| # | Что | Severity | Оценка | Комментарий |
|---|---|---|---|---|
| 1 | **Q1 — починить `ai.test.js`** | high | 1 ч | **Первым.** Пока раннер врёт, всё остальное бессмысленно |
| 2 | **Q2 — CI** | high | 30 мин | Лучшее соотношение эффект/усилие во всём аудите |
| 3 | Q3 — тесты на `isPro`/`gate` | high | 1 д | Деньги |
| 4 | Q4 — ESLint + `checkJs` | medium | 1 д | Ловит гейт-невидимый класс ошибок |
| 5 | Q5 — `PREMIUM_STAGE` | low | 2 ч | Перед запуском кассы |
| 6 | Q6 — CHANGELOG, чистка | low | 1 ч | |

**Q1 + Q2 = полтора часа работы**, и они превращают декоративный гейт в настоящий.
Это самая выгодная сделка в этом аудите — начинать надо с них.
