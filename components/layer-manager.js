/* ---------- Popover / Overlay Layer Manager ---------- */
const LayerManager = {
  stack: [],
  baseZ: 4000,
  stepZ: 100,

  // Registers a layer and assigns it a dynamic z-index.
  // element: DOM Element representing the popup/overlay
  // backdrop: optional DOM Element representing the matching dark backdrop
  // options: { isPopover: boolean } (popovers stack even higher to stay on top of fullscreen windows)
  open(element, backdrop = null, options = {}) {
    if (!element) return;
    
    // De-duplicate if already in stack
    this.close(element);

    const layer = {
      element,
      backdrop,
      isPopover: !!options.isPopover,
      origZ: element.style.zIndex || '',
      origBackdropZ: backdrop ? (backdrop.style.zIndex || '') : ''
    };

    this.stack.push(layer);
    this.recalculateZ();
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
      this.recalculateZ();
    }
  },

  // Re-calculates z-indices for all layers in the stack
  recalculateZ() {
    let currentZ = this.baseZ;
    this.stack.forEach(layer => {
      if (layer.isPopover) {
        // Popovers sit above all fullscreen panels (e.g. at 9500+)
        layer.element.style.zIndex = '9500';
        if (layer.backdrop) layer.backdrop.style.zIndex = '9499';
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
