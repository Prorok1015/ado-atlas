# План работ: Ленивая загрузка (Lazy Loading) скрытых полей сайдбара

## 1. Описание задачи
Каждый рабочий элемент Azure DevOps содержит множество полей, включая тяжелое HTML-содержимое описания (Description), критериев приемки (Acceptance Criteria), связей (Relations), вложений и комментариев. Загрузка всего объема данных сразу замедляет открытие сайдбара. Задача состоит в том, чтобы разделить загрузку на два этапа: мгновенное получение базовой информации (ID, Title, State, Type, Assignee, Priority) для быстрого рендеринга и фоновую/ленивую загрузку тяжелых блоков данных (описание, связи, история) по требованию.

---

## 2. Предлагаемые изменения по файлам

### [api.js](file:///c:/Users/proro/source/repos/Prorok1015/easy_ady_extention/api.js)
1. **Реализация `itemLight(wid, options)`**:
   - Метод запрашивает ограниченный набор полей с помощью параметра `fields` в GET-запросе (вместо `$expand=relations` или `$expand=all`):
     - `System.Id`, `System.Title`, `System.State`, `System.WorkItemType`, `System.AssignedTo`, `Microsoft.VSTS.Common.Priority`, `System.IterationPath`, `System.Parent`.
   - Это значительно уменьшает размер JSON-ответа от ADO и сокращает время ожидания.
2. **Модификация `item(wid, options)`**:
   - Метод `item` переименовать или использовать как полный запрос `itemFull(wid, options)` со всеми связями (`$expand=relations`) и тяжелыми текстовыми полями (`System.Description`, `Microsoft.VSTS.Common.AcceptanceCriteria`, `System.Tags`).

### [app.js](file:///c:/Users/proro/source/repos/Prorok1015/easy_ady_extention/app.js)
1. **Двухэтапный рендеринг в `openItem(id)`**:
   - Сначала вызвать `api.itemLight(id)` для быстрого получения базовых полей.
   - Сразу отрендерить заголовок задачи, заполнить текстовое поле названия `#s_title`, выпадающие списки статуса `#s_state`, приоритета `#s_prio`, назначенного сотрудника и спринта. Сделать эти поля доступными для редактирования.
   - В текстовых полях описания и AC вывести анимированные скелетоны-плейсхолдеры. Скрыть вкладку комментариев и вложений (или показать индикатор загрузки).
2. **Фоновый запрос тяжелых данных**:
   - После завершения отрисовки базовых полей запустить асинхронный фоновый запрос `api.itemFull(id)`.
   - По его готовности (с учетом токена `openToken` для предотвращения Race Condition):
     - Обновить поле описания, AC, тегов, связей и список вложений.
     - Убрать скелетоны-плейсхолдеры и разблокировать редакторы описания и AC.
3. **Ленивый запуск истории и комментариев**:
   - Загрузку комментариев и истории изменений (`api.comments` и `api.history`) запускать **только** при открытии секции "Activity" (кнопка `s_actbtn` / `#s_activity`).
   - Если пользователь не открывал историю активности, эти сетевые запросы не должны отправляться вовсе.

### [app.css](file:///c:/Users/proro/source/repos/Prorok1015/easy_ady_extention/app.css)
1. Реализовать CSS-стили для скелетонов (анимированных блоков с градиентной подсветкой) для имитации текста в текстовых областях описания и критериев приемки в процессе загрузки.

---

## 3. План верификации

### Ручное тестирование
1. **Проверка скорости отклика**:
   - Кликнуть на задачу. Проверить визуально, что сайдбар с заголовком, исполнителем и статусом открывается моментально.
   - В этот момент в областях описания должен отображаться скелетон загрузки. Через долю секунды скелетон должен замениться реальным текстом описания.
2. **Контроль сетевых запросов**:
   - Открыть инструменты разработчика -> вкладка Network.
   - Кликнуть по задаче. Убедиться, что сначала уходит быстрый запрос только с перечнем полей `fields=System.Id,...`, а следом идет второй запрос с `$expand=relations`.
   - Убедиться, что запросы к `comments` и `updates` отправляются строго в момент нажатия на кнопку "Activity" (🕑).
3. **Редактирование во время загрузки**:
   - Открыть задачу, мгновенно изменить статус или назначение (пока описание еще грузится). Проверить, что это изменение успешно сохранилось и не было перетерто после прихода ответа от фонового запроса `itemFull`.

# Промежуточные баги
## Решены
1. При быстрому переключению между итемами видимо новые поля не успевают отменять свои запросы и иногда срабатывает диалог дискарда данных хотя я в карточках ничего не изменял.
2. При включении отображения новых полей в лайауте они делают какой то кривой запрос и выбают ошибку
   api.js:244 
   GET https://dev.azure.com/ado-atlas/ado-atlas-preview/_apis/wit/workitems/1?api-version=7.1&fields= 400 (Bad Request)
   req	@	api.js:244
   await in req		
   item	@	api.js:693
   await in item		
   ensureFieldLoaded	@	app.js:117
   (anonymous)	@	app.js:3926
   applySideLayout	@	app.js:3920
   cb.onchange	@	app.js:3987
3. При быстром переключении между карточками в консоли накапливаются ошибки:
   dev.azure.com/ado-atlas/ado-atlas-preview/_apis/wit/workitems/7?api-version=7.1&fields=:1  Failed to load resource: the server responded with a status of 400 (Bad Request)
   index.html#:1 Executing inline event handler violates the following Content Security Policy directive 'script-src 'self''. Either the 'unsafe-inline' keyword, a hash ('sha256-...'), or a nonce ('nonce-...') is required to enable inline execution. Note that hashes do not apply to event handlers, style attributes and javascript: navigations unless the 'unsafe-hashes' keyword is present. The action has been blocked.
   index.html#:1 Executing inline event handler violates the following Content Security Policy directive 'script-src 'self' 'wasm-unsafe-eval' 'inline-speculation-rules' http://localhost:* http://127.0.0.1:*'. Either the 'unsafe-inline' keyword, a hash ('sha256-...'), or a nonce ('nonce-...') is required to enable inline execution. Note that hashes do not apply to event handlers, style attributes and javascript: navigations unless the 'unsafe-hashes' keyword is present. The action has been blocked.
   index.html#:1 Executing inline event handler violates the following Content Security Policy directive 'script-src 'self''. Either the 'unsafe-inline' keyword, a hash ('sha256-...'), or a nonce ('nonce-...') is required to enable inline execution. Note that hashes do not apply to event handlers, style attributes and javascript: navigations unless the 'unsafe-hashes' keyword is present. The action has been blocked.
   index.html#:1 Executing inline event handler violates the following Content Security Policy directive 'script-src 'self' 'wasm-unsafe-eval' 'inline-speculation-rules' http://localhost:* http://127.0.0.1:*'. Either the 'unsafe-inline' keyword, a hash ('sha256-...'), or a nonce ('nonce-...') is required to enable inline execution. Note that hashes do not apply to event handlers, style attributes and javascript: navigations unless the 'unsafe-hashes' keyword is present. The action has been blocked.
## Остались
4. Хорошо было бы ввести понятие групп в лайаут и дать возможность это настраивать. Например можно было бы линию Start-Target, Due, Est H Сделать группой и тогда можно было бы её разобрать или заменить в ней поля как хочешь. А то сейчас новые поля каждый на новой строчке и это выглядит не красиво.
5. Так же было бы здорово разработать компонент для ввода рабочего времени, который бы поддерживал математические операции со временем(например 1h + 3d + 1w - 4h) Надо продумать такой компонент и использовать везде где надо задавать рабочее время.
6. Поправить что ничего не отображается у поля парента если парент не задан в сайдбаре. Там стрелка перехода на родителя если родитель есть, но если его нет, то там просто пустое место. Надо либо рисовать кнопку задизейбленной, либо растягивать поле ввода до конца вправо.
7. Убрать возможность кастомизации у футера активити. Он должен всегда быть снизу.
8. Проверить поддержку undo/redo у всех полей.