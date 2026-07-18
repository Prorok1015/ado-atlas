/* ---------- Popover / Overlay Layer Manager ---------- */
const LayerManager = {
  stack: [],
  baseZ: 15000,
  stepZ: 100,

  // Registers a layer and assigns it a dynamic z-index.
  // element: DOM Element representing the popup/overlay
  // backdrop: optional DOM Element representing the matching dark backdrop
  // options: { isPopover: boolean } (popovers stack even higher to stay on top of fullscreen windows)
  open(element, backdrop = null, options = {}) {
    if (!element) return;
    
    // De-duplicate if already in stack
    this.close(element);

    const prevFocus = document.activeElement;
    
    if (!options.isPopover) {
      const box = element.firstElementChild && element.firstElementChild.id && element.firstElementChild.id.endsWith('-box') ? element.firstElementChild : element;
      if (!box.hasAttribute('role')) {
        box.setAttribute('role', 'dialog');
        box.setAttribute('aria-modal', 'true');
        const h2 = box.querySelector('h1, h2');
        if (h2) {
          if (!h2.id) h2.id = `layer-title-${Date.now()}`;
          box.setAttribute('aria-labelledby', h2.id);
        }
      }
    }

    const onKeyDown = (e) => {
      if (e.key === 'Tab') {
        const FOCUSABLE = 'a[href], area[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), iframe, object, embed, [tabindex="0"], [contenteditable]';
        const focusable = Array.from(element.querySelectorAll(FOCUSABLE)).filter(el => el.tabIndex !== -1);
        if (!focusable.length) {
          e.preventDefault();
          return;
        }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey) {
          if (document.activeElement === first || document.activeElement === document.body) {
            last.focus();
            e.preventDefault();
          }
        } else {
          if (document.activeElement === last || document.activeElement === document.body) {
            first.focus();
            e.preventDefault();
          }
        }
      }
    };

    element.addEventListener('keydown', onKeyDown);

    const layer = {
      element,
      backdrop,
      isPopover: !!options.isPopover,
      origZ: element.style.zIndex || '',
      origBackdropZ: backdrop ? (backdrop.style.zIndex || '') : '',
      prevFocus,
      onKeyDown
    };

    this.stack.push(layer);
    this.recalculateZ();
    
    // Auto focus first element
    setTimeout(() => {
      const FOCUSABLE = 'a[href], area[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), iframe, object, embed, [tabindex="0"], [contenteditable]';
      const focusable = Array.from(element.querySelectorAll(FOCUSABLE)).filter(el => el.tabIndex !== -1);
      if (focusable.length) {
        focusable[0].focus();
      }
    }, 10);
  },

  // Removes a layer and restores original z-indexes if any
  close(element) {
    if (!element) return;
    const idx = this.stack.findIndex(l => l.element === element);
    if (idx !== -1) {
      const [layer] = this.stack.splice(idx, 1);
      layer.element.style.zIndex = layer.origZ;
      if (layer.backdrop) {
        layer.backdrop.style.zIndex = layer.origBackdropZ;
      }
      layer.element.removeEventListener('keydown', layer.onKeyDown);
      this.recalculateZ();
      if (layer.prevFocus && typeof layer.prevFocus.focus === 'function') {
        layer.prevFocus.focus();
      }
    }
  },

  // Re-calculates z-indices for all layers in the stack
  recalculateZ() {
    let currentZ = this.baseZ;
    this.stack.forEach(layer => {
      if (layer.isPopover) {
        // Popovers sit above all fullscreen panels (e.g. at 20000+)
        layer.element.style.zIndex = '20000';
        if (layer.backdrop) layer.backdrop.style.zIndex = '19999';
      } else {
        if (layer.backdrop) {
          layer.backdrop.style.zIndex = String(currentZ - 1);
        }
        layer.element.style.zIndex = String(currentZ);
        currentZ += this.stepZ;
      }
    });
  }
};
window.LayerManager = LayerManager;
