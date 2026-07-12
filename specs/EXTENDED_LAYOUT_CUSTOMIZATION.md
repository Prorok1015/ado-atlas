# Extended Layout Customization — Toolbar & Bulk Form

## Статус: Planned (Free feature)

Расширить существующую schema-driven систему кастомизации лейаута (сейчас только Sidebar)
на **Toolbar** и **Bulk Form**.

---

## Мотивация

### Toolbar
- Тулбар уже перегружен: 3 вида отображения (Board, Tree, Timeline) + добавляется Analytics
- Будут появляться новые Pro-кнопки (export, analytics, etc.)
- Пользователю нужна возможность **группировать** кнопки (не просто show/hide)
- Пример: группа "Views" = Board + Tree + Timeline + Analytics, пользователь может
  убрать ненужные виды, оставив только используемые

### Bulk Form
- Сейчас 8 хардкоженных полей с простым reorder + show/hide
- Нет поддержки кастомных полей (custom fields из ADO)
- Нет per-type лейаутов (для Bug может быть нужен один набор полей, для Task — другой)
- Нет группировки полей (rows, columns)

---

## Текущее состояние vs Целевое

| Аспект | Sidebar (сейчас) | Toolbar (сейчас) | Toolbar (цель) | Bulk (сейчас) | Bulk (цель) |
|--------|------------------|-------------------|-----------------|---------------|-------------|
| Schema-driven | ✅ JSON schema | ❌ flat list | ✅ JSON schema | ❌ flat list | ✅ JSON schema |
| Группировка | ✅ groups | ❌ | ✅ groups | ❌ | ✅ groups/rows |
| Drag-and-drop билдер | ✅ visual builder | ❌ checkbox list | ✅ visual builder | ❌ checkbox list | ✅ visual builder |
| Per-type лейауты | ✅ `ado.layout.<WType>` | ❌ | ⚪ не нужно | ❌ | ✅ per-type |
| Custom fields | ✅ `cust:<ref>` | ❌ N/A | ❌ N/A | ❌ | ✅ |
| Ряды/колонки | ✅ rows + columns | ❌ N/A | ❌ N/A | ❌ | ✅ |

---

## Toolbar — Детали

### Схема лейаута

```js
{
  version: "1.0",
  layout: [
    {
      id: "grp_views",
      type: "group",
      title: "Views",
      elements: [
        { type: "button", ref: "board" },
        { type: "button", ref: "tree" },
        { type: "button", ref: "timeline" },
        { type: "button", ref: "analytics" }   // Pro, preview
      ]
    },
    { type: "separator" },
    {
      id: "grp_actions",
      type: "group",
      title: "Actions",
      elements: [
        { type: "button", ref: "export" },
        { type: "button", ref: "settings" },
        // ...
      ]
    }
  ]
}
```

### Визуальное представление групп на тулбаре
- Кнопки внутри группы визуально объединены (общий border-radius, разделитель между группами)
- Группы можно сворачивать в dropdown при нехватке места (responsive)
- Каждая кнопка внутри группы может быть скрыта

### Storage
- Ключ: `ado.toolbarLayout` (через `App.prefs`)
- Fallback: текущий хардкоженный порядок

---

## Bulk Form — Детали

### Схема лейаута (аналогично sidebar)

```js
{
  version: "1.0",
  wtype: "Bug",   // или "" для all-types default
  layout: [
    {
      id: "grp_workflow",
      type: "group",
      title: "Workflow",
      elements: [
        {
          type: "row",
          columns: [
            { width: "33%", elements: [{ type: "field", ref: "state" }] },
            { width: "33%", elements: [{ type: "field", ref: "priority" }] },
            { width: "34%", elements: [{ type: "field", ref: "assigned" }] }
          ]
        }
      ]
    },
    {
      id: "grp_planning",
      type: "group",
      title: "Planning",
      elements: [
        { type: "field", ref: "iteration" },
        { type: "field", ref: "parent" },
        { type: "field", ref: "dates" }
      ]
    },
    { type: "field", ref: "tags" },
    // Custom fields:
    { type: "field", ref: "cust:Custom.Severity" }
  ]
}
```

### Новые возможности
- **Custom fields в bulk**: динамическая генерация полей из ADO API (как в sidebar)
- **Per-type лейауты**: `ado.bulkLayout.<WType>` — разный набор полей для Bug vs Task vs Feature
- **Группировка**: визуальные секции с заголовками
- **Rows/Columns**: компактная компоновка полей в ряды

### Storage
- Ключ: `ado.bulkLayout.<WType>` (через `App.prefs.setDynamic`)
- Fallback: текущий хардкоженный набор из 8 полей

---

## Customize Modal — Изменения

Текущие 3 вкладки в Customize modal:
1. **Toolbar** — сейчас: checkbox list → цель: visual group builder
2. **Work Item Panel** — уже visual builder ✅
3. **Bulk Edit** — сейчас: checkbox list → цель: visual builder (как sidebar)

### Toolbar tab (новый)
- Toolbox: доступные кнопки + структурные элементы (Group, Separator)
- Canvas: preview тулбара с группами
- Drag-and-drop для перемещения кнопок между группами

### Bulk Edit tab (новый)
- Аналогичен текущему sidebar visual builder
- Toolbox: Group, Row, Separator + Available Fields (включая custom fields)
- Canvas: preview bulk-формы
- Type chips сверху для per-type настройки

---

## Зависимости

- Не зависит от бэкенда
- Переиспользует существующую инфраструктуру из `layout.js`:
  - `renderNode()` — рекурсивный рендер schema-узлов
  - `renderVisualLayoutBuilder()` — визуальный билдер (нужно обобщить для 3 контекстов)
  - Schema migration utilities
- Нужно будет обобщить `layout.js`, вынеся общую логику schema/builder
  в shared-функции, параметризованные по контексту (sidebar / toolbar / bulk)
