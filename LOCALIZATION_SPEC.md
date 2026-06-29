# Техническое задание: Локализация (i18n) ADO Atlas

Как правильно добавить многоязычность в расширение с учётом его архитектуры (классические `<script>` в общем глобальном скоупе, IIFE-обёртки, чистый `lib.js`, отсутствие бандлера, кастомные диалоги, `ui-icon`).

---

## 1. Цели и принципы

- **Пользователь сам выбирает язык** в настройках (как тему и масштаб), переключение **на лету** без перезагрузки страницы.
- Английский — базовый/fallback язык. Любой отсутствующий ключ откатывается на EN, затем на сам ключ (чтобы ничего не «исчезало»).
- Никакого FOUC (вспышки непереведённого текста) — активный словарь применяется максимально рано.
- Соблюдаем паттерны проекта: IIFE + экспорт в `global`, чистые функции в `lib.js`, кастомные диалоги, без эмодзи, тема-зависимость не затрагивается.
- Внедрение **поэтапное**: инфраструктура → строки тулбара/настроек → диалоги → остальное. Не требуется переписать всё сразу.

---

## 2. Подход: гибрид (свой рантайм-слой + `chrome.i18n` только для метаданных)

**Важное ограничение:** штатный `chrome.i18n` (+ `_locales/<lang>/messages.json`, `__MSG_x__`) берёт язык **из языка интерфейса браузера и не переключается в рантайме** — пользователь не сможет сменить язык внутри приложения. Поэтому:

- **In-app UI** (тулбар, панели, диалоги, тексты) локализуем **своим лёгким рантайм-слоем** (`window.i18n.t(...)` + JSON-словари), чтобы поддержать переключатель языка.
- **`chrome.i18n` + `_locales/`** используем **только** для метаданных в Chrome Web Store: `name`, `description` в `manifest.json` (Chrome подставляет их по локали браузера при установке). Это единственное место, где `_locales` оправдан.

---

## 3. Архитектура рантайм-слоя

### 3.1 Словари — `locales/<lang>.json`
Плоские (или неглубоко вложенные) словари «ключ → строка»:
```
locales/
  en.json   ← базовый, полный набор ключей (источник правды)
  ru.json
  uk.json   ← и т.д.
```
```json
// locales/en.json
{
  "toolbar.new": "New",
  "toolbar.fit": "Fit",
  "paywall.activate": "Activate",
  "paywall.buy": "Get ADO Atlas Pro — $5/mo",
  "notify.itemsFollowed": "{count} items followed",
  "common.cancel": "Cancel"
}
```
Загружаются асинхронно через `fetch(chrome.runtime.getURL('locales/<lang>.json'))`. **EN бандлим инлайном** (или грузим первым и синхронно ждём) — он fallback и должен быть всегда доступен.

### 3.2 Чистый помощник в `lib.js`
Интерполяция — детерминированная и тестируемая, поэтому живёт в `lib.js` (без DOM/chrome):
```js
// lib.js — pure
function formatMessage(template, params) {
  if (!template) return '';
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m));
}
// export в global как остальные хелперы lib.js
```
Юнит-тест в `tests/lib.test.js` (плейсхолдеры, отсутствующий ключ, пустой шаблон).

### 3.3 Ядро — `components/i18n.js` → `window.i18n`
```js
(function (global) {
  'use strict';
  const FALLBACK = 'en';
  let lang = FALLBACK;
  let dict = {};          // активный словарь
  let fallbackDict = {};  // en, всегда загружен
  const listeners = [];

  async function load(l) {
    const res = await fetch(chrome.runtime.getURL(`locales/${l}.json`));
    return res.ok ? res.json() : {};
  }

  const i18n = {
    async init(initialLang) {
      fallbackDict = await load(FALLBACK);
      await this.setLang(initialLang || global.i18nDetectLang(), { silent: true });
    },
    // t(key, params) → строка; fallback: активный → en → сам ключ
    t(key, params) {
      const tmpl = (key in dict) ? dict[key] : (key in fallbackDict ? fallbackDict[key] : key);
      return global.formatMessage(tmpl, params);
    },
    getLang() { return lang; },
    async setLang(l, opts = {}) {
      lang = l;
      dict = (l === FALLBACK) ? fallbackDict : await load(l);
      try { localStorage.setItem('ado.lang', l); } catch (e) {}
      document.documentElement.setAttribute('lang', l);
      // RTL: document.documentElement.setAttribute('dir', RTL_LANGS.has(l) ? 'rtl' : 'ltr');
      if (!opts.silent) { this.applyDOM(); listeners.forEach(cb => { try { cb(l); } catch (e) {} }); }
    },
    onChange(cb) { if (typeof cb === 'function') listeners.push(cb); },
    // Перевод статического DOM по data-* атрибутам (см. §4)
    applyDOM(root = document) {
      root.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = i18n.t(el.dataset.i18n); });
      root.querySelectorAll('[data-i18n-title]').forEach(el => { el.title = i18n.t(el.dataset.i18nTitle); });
      root.querySelectorAll('[data-i18n-placeholder]').forEach(el => { el.placeholder = i18n.t(el.dataset.i18nPlaceholder); });
      root.querySelectorAll('[data-i18n-html]').forEach(el => { el.innerHTML = i18n.t(el.dataset.i18nHtml); });
    }
  };
  global.i18n = i18n;
})(typeof globalThis !== 'undefined' ? globalThis : window);
```

### 3.4 Раннее определение языка — `i18n-init.js` (по паттерну `theme-init.js`)
Маленький скрипт **до** основного UI, чтобы выставить `<html lang>` и не мигать:
```js
(function () {
  try {
    const saved = localStorage.getItem('ado.lang');
    const lang = saved || (chrome?.i18n?.getUILanguage?.() || navigator.language || 'en').slice(0, 2);
    document.documentElement.setAttribute('lang', lang);
    window.i18nDetectLang = () => lang;
  } catch (e) { window.i18nDetectLang = () => 'en'; }
})();
```
Подключается в `<head>` рядом с `theme-init.js`. Затем в boot (`DOMContentLoaded`) — `await window.i18n.init()` **до** первого рендера UI, и `i18n.applyDOM()`.

**FOUC:** статический HTML оставляем на EN (он же fallback). Поскольку `i18n.init()` грузит словарь до показа основного контента, перевод применяется один раз на старте. Если потребуется абсолютный ноль вспышки для не-EN — бандлить активный словарь инлайном (генерация при сборке), но это оптимизация второго порядка.

---

## 4. Externalize: статическая разметка (`index.html`)

Заменяем хардкод-текст на `data-i18n*`-атрибуты; `applyDOM()` проставит значения:
```html
<!-- было -->
<button class="btn save" id="newbtn" title="create a new work item (N)"><ui-icon name="plus"></ui-icon> New</button>
<!-- стало -->
<button class="btn save" id="newbtn" data-i18n-title="toolbar.new.title"><ui-icon name="plus"></ui-icon> <span data-i18n="toolbar.new">New</span></button>
```
Правила:
- **Видимый текст** → оборачиваем в элемент с `data-i18n` (часто `<span>`, чтобы не трогать иконку рядом). Содержимое тега оставляем как EN-дефолт.
- **`title=`** (в проекте ~83 шт.) → `data-i18n-title`.
- **`placeholder=`** → `data-i18n-placeholder`.
- **Сложная разметка в подсказках** (`data-tooltip-html`, многострочные) → `data-i18n-html` с ключом, значение в словаре содержит HTML.

---

## 5. Externalize: динамические строки (`app.js`, компоненты)

Литералы в шаблон-строках и диалогах → `i18n.t()`:
```js
// было
if (window.customAlert) window.customAlert('This Pro feature is coming soon.', 'Pro');
// стало
window.customAlert(i18n.t('paywall.comingSoon'), i18n.t('paywall.title'));

// с параметрами
log(i18n.t('notify.itemsFollowed', { count: n }));   // "{count} items followed"
```
- Компоненты, рендерящие свой DOM (paywall, filter-builder, ai-dialog), при построении вызывают `i18n.t()` и/или ставят `data-i18n*` и зовут `i18n.applyDOM(ownRoot)`.
- На `i18n.onChange()` динамические/самостоятельные панели перерисовываются или повторно зовут `applyDOM`.

Внедрять **по областям** (toolbar → settings → paywall → filter-builder → ai-dialog → tutorials), не одним коммитом.

---

## 6. Выбор и хранение языка (селектор в настройках)

В popover настроек (`#morepanel`) добавить строку «Language» рядом с Theme/UI Scale (тот же паттерн `<select>`):
```html
<div class="mrow"><span class="ml" data-i18n="settings.language">Language</span>
  <select id="f_lang" title="interface language">
    <option value="en">English</option>
    <option value="ru">Русский</option>
    <option value="uk">Українська</option>
  </select></div>
```
Wiring (`app.js`): `$('f_lang').value = i18n.getLang(); $('f_lang').onchange = () => i18n.setLang($('f_lang').value);`
Хранение — `localStorage 'ado.lang'` (как `ado.theme`). Если язык нужен в `background.js` (тексты уведомлений) — дублировать в `chrome.storage.local` и читать там отдельным мини-словарём (см. §9).

---

## 7. Локале-зависимое форматирование (Intl) и RTL

- Даты/числа: сейчас местами захардкожен `toLocaleString('en-US', …)` (напр. `app.js`). Перевести на активную локаль: `toLocaleString(i18n.getLang(), …)` или `Intl.DateTimeFormat(i18n.getLang(), …)`. Вынести формат-хелперы в одно место.
- RTL: при добавлении ar/he — `document.documentElement.dir = 'rtl'` в `setLang` (заготовка в §3.3). CSS — предпочесть логические свойства (`margin-inline-start` и т.п.) в новых стилях.

---

## 8. Соглашение по ключам

`<область>.<подобласть>.<смысл>`, lowerCamel для листа: `toolbar.new`, `toolbar.new.title`, `settings.language`, `paywall.activate`, `filter.save.confirm`, `notify.itemsFollowed`, `common.cancel`. Общие переиспользуемые — в `common.*`. Никаких строк-ключей «по тексту» (чтобы правка EN-текста не ломала ключ).

---

## 9. Что НЕ локализуем

- **Данные из Azure DevOps** (названия задач, состояний, пользователей, area/iteration paths) — это контент, остаётся как есть.
- **AI-промпты** (`ai/prompts/*`, системные инструкции к модели) — это не UI; язык промпта диктуется моделью/логикой, не интерфейсом. Локализуется только то, что видит пользователь.
- **`background.js`**: сервис-воркер грузит лишь `lib.js`+`api.js`. Тексты desktop-уведомлений — отдельный минимальный путь: читать `ado.lang` из `chrome.storage.local` и держать компактный словарь уведомлений (либо инлайн-объект), не таща весь рантайм-слой в воркер.

---

## 10. `manifest.json` + `_locales` (только метаданные стора)

```jsonc
{
  "default_locale": "en",
  "name": "__MSG_appName__",
  "description": "__MSG_appDesc__"
}
```
```
_locales/en/messages.json  → { "appName": {"message":"ADO Atlas"}, "appDesc": {"message":"..."} }
_locales/ru/messages.json  → переводы name/description
```
Это локализует карточку в Web Store по локали браузера. **In-app тексты сюда не кладём** — для них §3.

---

## 11. Сборка и тесты

- **`build.ps1`**: добавить каталоги `locales` и `_locales` в `$dirs` (сейчас копирует `vendor/icons/components/ai` рекурсивно). JSON-словари не валидируются `check-globals` (это не JS).
- **`tools/check-globals.js`**: добавить `components/i18n.js` в список (IIFE — коллизий не даст). `i18n-init.js` грузится как `theme-init.js` (вне списка проверки, как и он).
- **Тесты**: `formatMessage` — юнит-тесты в `tests/lib.test.js`. Плюс «псевдо-локаль» (напр. `locales/pseudo.json`, где значения — `[!!! …]`) для ручной проверки покрытия: непереведённые места сразу видно.
- **Линт ключей** (опционально): мини-скрипт сверяет, что все ключи из `ru/uk` существуют в `en` и наоборот (нет «осиротевших»/недостающих ключей).

---

## 12. Поэтапный план

1. **Инфраструктура:** `formatMessage` в `lib.js` + тест; `components/i18n.js`; `i18n-init.js`; `locales/en.json` (пустой каркас); подключить скрипты; `await i18n.init()` в boot; селектор языка в настройках.
2. **Toolbar + Settings:** проставить `data-i18n*` на статике `index.html`, заполнить `en.json`. Добавить первый перевод (`ru.json`).
3. **Диалоги:** paywall, setup/connection, filter-builder, ai-dialog — `t()` в их рендере + `applyDOM(ownRoot)` + перерисовка на `onChange`.
4. **Динамика `app.js`:** `customAlert/Confirm`, статус-строки, легенды; Intl-форматирование дат/чисел.
5. **Уведомления `background.js`** (мини-словарь) и метаданные стора (`_locales`).
6. **`tutorials.json`** — локализуемый контент туров (отдельный объём; делать в последнюю очередь, можно вынести в `tutorials.<lang>.json`).
7. Доп. языки + псевдо-локаль в CI/ручном тесте.

---

## 13. Открытые вопросы

- Набор языков для MVP (EN + RU + UK? + DE/ES?).
- Бандлить ли активный словарь инлайном ради нулевого FOUC (vs async-загрузка — проще, вспышка минимальна).
- `tutorials.json` — переводить силами сообщества или централизованно.
