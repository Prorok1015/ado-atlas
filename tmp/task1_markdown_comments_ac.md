# План работ: Компонентный Markdown-редактор для описания, критериев приемки и комментариев

## 1. Описание задачи
Вместо дублирования разметки и обработчиков событий для трех разных текстовых областей (Description, Acceptance Criteria и Comments), предлагается вынести редактор в единый переиспользуемый компонент на базе класса JavaScript (`MarkdownEditor`). Это обеспечит идентичный пользовательский опыт, упростит кодовую базу, решит проблему автовыравнивания, вставки файлов, автозаполнения упоминаний и переключения предпросмотра.

---

## 2. Архитектура компонента `MarkdownEditor`

Компонент будет инкапсулировать в себе:
1. **Разметку**: Генерацию тулбара форматирования, текстового поля ввода (`<textarea>`), контейнера предпросмотра HTML (`.mdview`), области перетаскивания файлов (drag'n'drop dropzone) и индикаторов загрузки.
2. **Логику форматирования**: Обработку горячих клавиш (`Ctrl+B`, `Ctrl+I`) и кликов по кнопкам тулбара (жирный, курсив, списки, ссылки).
3. **Работу с вложениями**: Перетаскивание файлов (drag'n'drop) и вставку изображений из буфера обмена (paste), если данная опция включена (`allowAttachments: true`).
4. **Упоминания пользователей**: Интеграцию с выпадающим окном автодополнения на символ `@` (Identity Picker).

---

## 3. Детальные изменения по файлам

### [NEW] [MarkdownEditor class] в [app.js](file:///c:/Users/proro/source/repos/Prorok1015/easy_ady_extention/app.js)
Создать класс `MarkdownEditor` в начале файла `app.js` (или в `lib.js`, но удобнее в `app.js`, так как компонент тесно взаимодействует с DOM и API):

```javascript
class MarkdownEditor {
  constructor(containerEl, options = {}) {
    this.container = typeof containerEl === 'string' ? document.getElementById(containerEl) : containerEl;
    this.options = Object.assign({
      label: 'Текст',
      placeholder: 'Введите текст в формате Markdown...',
      allowAttachments: false,
      allowMentions: true,
      onInput: null,
      onSave: null // для автосохранения по Ctrl+S
    }, options);
    
    this.valueStr = '';
    this.isEditMode = true;
    this.render();
    this.initElements();
    this.bindEvents();
  }

  // Генерация HTML-структуры компонента
  render() {
    this.container.innerHTML = `
      <div class="desc-tools">
        <label class="dlabel">${this.options.label}</label>
        <div class="dfmt">
          <button type="button" class="dbtn dbtn-bold" title="Жирный (Ctrl+B)"><b>B</b></button>
          <button type="button" class="dbtn dbtn-italic" title="Курсив (Ctrl+I)"><i>I</i></button>
          <button type="button" class="dbtn dbtn-strike" title="Зачеркнутый"><s>S</s></button>
          <button type="button" class="dbtn dbtn-code" title="Код">&lt;/&gt;</button>
          <span class="dsep"></span>
          <button type="button" class="dbtn dbtn-h" title="Заголовок">H</button>
          <button type="button" class="dbtn dbtn-ul" title="Маркированный список">•</button>
          <button type="button" class="dbtn dbtn-ol" title="Нумерованный список">1.</button>
          <button type="button" class="dbtn dbtn-quote" title="Цитата">❝</button>
          <button type="button" class="dbtn dbtn-link" title="Вставить ссылку">🔗</button>
        </div>
        <button type="button" class="dbtn icon dbtn-toggle" title="Предпросмотр / Редактирование">👁</button>
      </div>
      <div class="desc-wrap">
        <textarea placeholder="${this.options.placeholder}"></textarea>
        <div class="mdview" style="display:none"></div>
        ${this.options.allowAttachments ? '<div class="desc-dropzone"><div class="ddz-inner">📎 Перетащите файл сюда</div></div>' : ''}
      </div>
      ${this.options.allowAttachments ? '<input type="file" multiple style="display:none">' : ''}
    `;
  }

  initElements() {
    this.textarea = this.container.querySelector('textarea');
    this.previewDiv = this.container.querySelector('.mdview');
    this.toggleBtn = this.container.querySelector('.dbtn-toggle');
    this.toolsDiv = this.container.querySelector('.dfmt');
    this.fileInput = this.container.querySelector('input[type="file"]');
    this.dropzone = this.container.querySelector('.desc-dropzone');
  }

  // Биндинг всех событий: ввод, форматирование, горячие клавиши, вставки, drag'n'drop
  bindEvents() {
    this.toggleBtn.onclick = () => this.togglePreview();
    // Обработка кликов по кнопкам форматирования
    this.toolsDiv.addEventListener('click', (e) => this.handleFormat(e));
    // Обработка горячих клавиш внутри textarea
    this.textarea.addEventListener('keydown', (e) => this.handleKeydown(e));
    // Обработка ввода (для автовысоты, mentions и dirty check)
    this.textarea.addEventListener('input', () => this.handleInput());
    
    if (this.options.allowAttachments) {
      this.initAttachmentEvents();
    }
    if (this.options.allowMentions) {
      this.initMentionEvents();
    }
  }

  // Методы геттера / сеттера значения
  get value() { return this.textarea.value; }
  set value(val) {
    this.textarea.value = val || '';
    if (!this.isEditMode) {
      this.renderPreview();
    }
  }

  // Логика переключения предпросмотра
  togglePreview(forceOn) {
    const on = forceOn !== undefined ? forceOn : (this.textarea.style.display !== 'none');
    this.isEditMode = !on;
    if (on) {
      this.renderPreview();
      this.textarea.style.display = 'none';
      this.previewDiv.style.display = 'block';
      this.toggleBtn.textContent = '✎';
      this.toggleBtn.classList.add('on');
    } else {
      this.previewDiv.style.display = 'none';
      this.textarea.style.display = 'block';
      this.toggleBtn.textContent = '👁';
      this.toggleBtn.classList.remove('on');
      this.textarea.focus();
    }
  }

  renderPreview() {
    this.previewDiv.innerHTML = AdoLib.mdToHtml(this.textarea.value, descRenderOpts());
    // Вызов фоновой загрузки изображений вложений
    hydratePreviewImagesIn(this.previewDiv);
  }
}
```

### [MODIFY] [index.html](file:///c:/Users/proro/source/repos/Prorok1015/easy_ady_extention/index.html)
Вместо сложных блоков верстки для описания, AC и комментариев, оставить простые контейнеры-заглушки:
1. **Секция описания**:
   ```html
   <div class="sgroup" data-sg="desc" id="editor_desc_container"></div>
   ```
2. **Секция критериев приемки (AC)**:
   ```html
   <div class="sgroup" data-sg="ac" id="editor_ac_container"></div>
   ```
3. **Поле ввода комментария**:
   ```html
   <div id="comment_editor_container"></div>
   ```

### [MODIFY] [app.js](file:///c:/Users/proro/source/repos/Prorok1015/easy_ady_extention/app.js)
1. **Инициализация редакторов**:
   Создать три глобальных экземпляра `MarkdownEditor`:
   ```javascript
   let descEditor, acEditor, commentEditor;
   ```
   Инициализировать их в функции `init()`:
   ```javascript
   descEditor = new MarkdownEditor('editor_desc_container', {
     label: 'Description',
     allowAttachments: true,
     onInput: () => refreshDirty()
   });
   
   acEditor = new MarkdownEditor('editor_ac_container', {
     label: 'Acceptance Criteria',
     onInput: () => refreshDirty()
   });
   
   commentEditor = new MarkdownEditor('comment_editor_container', {
     label: 'New Comment',
     placeholder: 'Write a comment (Markdown)...'
   });
   ```
2. **Удаление дублирующейся логики**:
   - Удалить функции `showDescPreview`, `descFormatTarget`, `fireDescChange`, `wrapSel`, `prefixLines` и привязанные к ним обработчики событий (всё это переезжает в методы класса `MarkdownEditor`).
   - Использовать `descEditor.value`, `acEditor.value`, `commentEditor.value` для получения и установки значений вместо прямого обращения к `$('s_desc').value`, `$('s_ac').value`, `$('cm_text').value`.

---

## 4. План верификации

### Ручное тестирование
1. **Синхронность функционала**:
   - Открыть карточку, протестировать вставку Markdown (жирный, курсив, заголовки, списки) во всех трех редакторах.
   - Убедиться, что сочетания клавиш (`Ctrl+B`, `Ctrl+I`) работают одинаково в описании, AC и комментариях.
2. **Предпросмотр**:
   - Нажать иконку глаза (👁) на описании, AC и новом комменте. Проверить корректность рендеринга Markdown в HTML.
3. **Упоминания**:
   - Ввести `@` во всех трех полях. Окно автодополнения должно появляться строго под кареткой активного редактора. Выбор пользователя клавишей Enter должен вставлять упоминание в правильное поле.
