# Specification: Advanced Sidebar Layout Customization

This specification outlines the architecture, user experience, data schema, and implementation plan for the **Advanced Sidebar Layout Customization** in the Easy ADO Extension.

---

## 1. Overview & Goal

Currently, the sidebar panel customization is limited to a linear ordering list where users can drag fields up/down and toggle their visibility. 

The goal of the **Advanced Layout Customization** is to transition from a list-based reordering system to a **Visual Layout Builder**. This will allow users to:
1. **Organize fields into visual groups/sections** (collapsible panels).
2. **Arrange fields side-by-side** using a multi-column grid layout.
3. **View changes in real-time** via an interactive preview with placeholder values (e.g., fake descriptions, dropdown values, assignees).
4. **Insert structural elements** like custom headers, separators, or markdown hint blocks.

---

## 2. User Experience & UI Design

The Customization Overlay will be redesigned to support a split-screen visual builder:

```
+-----------------------------------------------------------------------------------+
|  Customize Sidebar: User Story                                            [Reset] |
+------------------------------------+----------------------------------------------+
|  Toolbox (Drag Elements)           |  Visual Layout Editor (Live Preview)         |
|                                    |                                              |
|  [Sections & Structures]           |  ==========================================  |
|  [+] New Group / Panel             |  [ Header: Title, State, Priority ]          |
|  [+] 2-Column Row                  |  ==========================================  |
|  [+] Custom Label / Text           |  +----------------------------------------+  |
|                                    |  | V Schedule (Group)               [x]  |  |
|  [Available Fields]                |  | +------------------+-----------------+ |  |
|  [ ] Remaining Work                |  | | Start Date       | Target Date     | |  |
|  [ ] Story Points                  |  | | [ Select date...]| [ Select date...]| |  |
|  [ ] Completed Work                |  | +------------------+-----------------+ |  |
|  [ ] Risk                          |  +----------------------------------------+  |
|  [ ] Business Value                |  +----------------------------------------+  |
|  [ ] Custom.TargetRelease          |  | V Description (Group)            [x]  |  |
|                                    |  | [ Markdown Editor Placeholder...     ] |  |
|                                    |  +----------------------------------------+  |
+------------------------------------+----------------------------------------------+
```

### Key UI Features:
- **Left Panel (Toolbox)**:
  - List of unused fields categorized by type (standard, custom).
  - Visual builder components: "Collapsible Group", "2-Column Row", "Horizontal Divider", "Info Text Block".
- **Right Panel (Canvas & Live Preview)**:
  - An interactive live preview of the sidebar layout.
  - Controls, inputs, and fields will render with realistic placeholder data (e.g., active states like `Doing`, fake tag chips, or a rich description editor mockup).
  - Structural blocks, rows, and groups will have grab handles to drag and reorder them on the canvas.
  - Delete icons `[x]` on groups/elements to quickly remove them (returning fields to the toolbox).

---

## 3. Data Schema

To support structured sections, columns, and groups, the layout configuration schema will be stored in `localStorage` per work item type (`ado.layout.<Wtype>`).

### JSON Schema Definition:

```json
{
  "version": "1.0",
  "wtype": "User Story",
  "layout": [
    {
      "id": "nav",
      "type": "system",
      "visible": true
    },
    {
      "id": "system_header",
      "type": "row",
      "columns": [
        { "width": "60%", "elements": ["title"] },
        { "width": "40%", "elements": ["workflow"] }
      ]
    },
    {
      "id": "group_schedule",
      "type": "group",
      "title": "Schedule & Planning",
      "collapsible": true,
      "defaultCollapsed": false,
      "elements": [
        {
          "type": "row",
          "columns": [
            { "width": "50%", "elements": ["sprint"] },
            { "width": "50%", "elements": ["parent"] }
          ]
        },
        {
          "type": "field",
          "ref": "cust:Custom.TargetRelease"
        }
      ]
    },
    {
      "id": "group_desc",
      "type": "group",
      "title": "Description",
      "collapsible": true,
      "elements": [
        { "type": "field", "ref": "desc" }
      ]
    }
  ]
}
```

---

## 4. Technical Architecture

### 4.1. Layout Renderer Engine
Instead of mapping `SIDE_GROUPS` statically to elements in the HTML page, `app.js` will include a dynamic **Layout Builder & Renderer**:
1. It reads the schema `ado.layout.<Wtype>`.
2. It recursively builds DOM structures (groups, grids, rows).
3. It initializes the field input elements (assignee combobox, datepickers, custom textareas) inside those structured columns.
4. It sets up classes to toggle panel collapses and saves state.

### 4.2. Drag and Drop Interaction
To keep it lightweight and zero-dependency, the drag-and-drop interface will use standard HTML5 Drag & Drop:
- Elements in the Toolbox will have `draggable="true"` and `data-ref="..."`.
- Containers in the Right Preview Pane will listen to `dragover`, `dragenter`, `dragleave`, and `drop` events.
- Elements will show interactive drop indicator lines between rows and columns during dragging.

---

## 5. Implementation Roadmap

### Phase 1: Core Layout Renderer
- [ ] Migrate `SIDE_GROUPS` loading from flat `sideOrder` and `sideHidden` arrays to the structured JSON schema.
- [ ] Implement the recursive renderer in `app.js` that renders groups and grid rows.
- [ ] Ensure that custom fields dynamically append inside their assigned layout slots.

### Phase 2: Design Sandbox Interface
- [ ] Implement the split layout designer panel in the Customization modal (`customize-overlay`).
- [ ] Create mock data renderer for inputs in the preview screen.
- [ ] Implement toolbox containing structure components and unused fields.

### Phase 3: Drag & Drop Logic
- [ ] Set up visual drop zones inside the preview container.
- [ ] Implement drop listeners to update the internal layout JSON tree on drop.
- [ ] Implement serialization of layout schema back to `localStorage`.

### Phase 4: Verification and Polishing
- [ ] Ensure backward compatibility: convert old flat `ado.sideOrder` and `ado.sideHidden` storage formats seamlessly to the new structured layout model.
- [ ] Verify that inline date-pickers, autocomplete inputs, and event listeners load correctly regardless of their container structure.
