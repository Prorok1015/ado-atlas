(function(global) {
  'use strict';

  class CustomSelect {
    constructor(selectEl) {
      if (!selectEl || selectEl.dataset.customSelectInitialized) return;
      this.selectEl = selectEl;
      this.selectEl.dataset.customSelectInitialized = 'true';

      // Hide native select
      this.selectEl.style.setProperty('display', 'none', 'important');

      // Create container
      this.container = document.createElement('div');
      this.container.className = 'custom-select-container';
      if (this.selectEl.id) this.container.id = `${this.selectEl.id}-custom-container`;
      
      // Copy layout/width attributes
      if (this.selectEl.style.width) this.container.style.width = this.selectEl.style.width;
      if (this.selectEl.style.minWidth) this.container.style.minWidth = this.selectEl.style.minWidth;
      if (this.selectEl.style.maxWidth) this.container.style.maxWidth = this.selectEl.style.maxWidth;
      if (this.selectEl.style.flex) this.container.style.flex = this.selectEl.style.flex;
      
      // Create trigger button
      this.trigger = document.createElement('button');
      this.trigger.type = 'button';
      this.trigger.className = 'custom-select-trigger';
      this.trigger.setAttribute('aria-haspopup', 'listbox');
      this.trigger.setAttribute('aria-expanded', 'false');
      
      // Copy title/tooltip attributes if any
      if (this.selectEl.title) this.trigger.title = this.selectEl.title;
      if (this.selectEl.dataset.i18nTitle) this.trigger.dataset.i18nTitle = this.selectEl.dataset.i18nTitle;
      
      this.container.appendChild(this.trigger);
      
      // Insert container in DOM next to native select
      this.selectEl.parentNode.insertBefore(this.container, this.selectEl.nextSibling);

      // Create dropdown options list (but don't append to body until opened)
      this.dropdown = document.createElement('div');
      this.dropdown.className = 'custom-select-dropdown';
      this.dropdown.setAttribute('role', 'listbox');

      // Bind events
      this.trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        this.toggle();
      });

      // Observe mutations on native select options to keep in sync
      this.observer = new MutationObserver(() => {
        this.sync();
      });
      this.observer.observe(this.selectEl, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['disabled']
      });

      // Intercept programmatic value changes
      const self = this;
      const originalValueProp = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
      Object.defineProperty(this.selectEl, 'value', {
        get() {
          return originalValueProp.get.call(this);
        },
        set(val) {
          originalValueProp.set.call(this, val);
          self.updateTriggerText();
        },
        configurable: true
      });

      const originalSelectedIndexProp = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'selectedIndex');
      Object.defineProperty(this.selectEl, 'selectedIndex', {
        get() {
          return originalSelectedIndexProp.get.call(this);
        },
        set(val) {
          originalSelectedIndexProp.set.call(this, val);
          self.updateTriggerText();
        },
        configurable: true
      });

      // Also listen to change event on the native select in case JS code updates it directly
      this.changeHandler = () => {
        this.updateTriggerText();
      };
      this.selectEl.addEventListener('change', this.changeHandler);

      // Keep track of instances
      CustomSelect.instances.add(this);

      // Initial sync
      this.sync();
    }

    sync() {
      // Update disabled state
      if (this.selectEl.disabled) {
        this.trigger.disabled = true;
        this.container.classList.add('disabled');
      } else {
        this.trigger.disabled = false;
        this.container.classList.remove('disabled');
      }

      // Rebuild options list inside the dropdown
      this.dropdown.innerHTML = '';
      
      Array.from(this.selectEl.options).forEach((opt) => {
        const item = document.createElement('div');
        item.className = 'custom-select-option';
        item.setAttribute('role', 'option');
        item.dataset.value = opt.value;
        item.textContent = opt.textContent;
        item.tabIndex = 0; // Focusable for LayerManager focus trapping
        
        // Match original option dataset i18n
        if (opt.dataset.i18n) {
          item.dataset.i18n = opt.dataset.i18n;
        }

        item.addEventListener('click', (e) => {
          e.stopPropagation();
          this.select(opt.value);
        });

        item.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            this.select(opt.value);
          }
        });

        this.dropdown.appendChild(item);
      });

      this.updateTriggerText();
    }

    updateTriggerText() {
      const selectedOpt = this.selectEl.options[this.selectEl.selectedIndex];
      if (selectedOpt) {
        this.trigger.textContent = selectedOpt.textContent;
        // Keep i18n in sync
        if (selectedOpt.dataset.i18n) {
          this.trigger.dataset.i18n = selectedOpt.dataset.i18n;
        } else {
          delete this.trigger.dataset.i18n;
        }
        
        // Mark active option
        Array.from(this.dropdown.children).forEach(child => {
          if (child.dataset.value === selectedOpt.value) {
            child.classList.add('selected');
            child.setAttribute('aria-selected', 'true');
          } else {
            child.classList.remove('selected');
            child.setAttribute('aria-selected', 'false');
          }
        });
      } else {
        this.trigger.textContent = '';
        delete this.trigger.dataset.i18n;
      }
    }

    select(value) {
      if (this.selectEl.value !== value) {
        // Use property setter descriptor directly to prevent infinite loops since we intercepted setter
        const originalValueProp = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
        originalValueProp.set.call(this.selectEl, value);
        this.updateTriggerText();
        
        // Trigger native change events so existing listeners react
        this.selectEl.dispatchEvent(new Event('change', { bubbles: true }));
      }
      this.close();
    }

    toggle() {
      if (this.isOpen()) {
        this.close();
      } else {
        this.open();
      }
    }

    isOpen() {
      return this.dropdown.parentNode !== null;
    }

    open() {
      if (this.isOpen()) return;

      // Position the dropdown relative to the trigger
      const rect = this.trigger.getBoundingClientRect();
      this.dropdown.style.position = 'absolute';
      this.dropdown.style.minWidth = `${rect.width}px`;

      let left = rect.left + window.scrollX;
      this.dropdown.style.left = `${left}px`;

      // Append directly to body to measure dimensions
      document.body.appendChild(this.dropdown);

      const dropdownRect = this.dropdown.getBoundingClientRect();
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;

      // Adjust left if it overflows the viewport right edge
      if (dropdownRect.right > viewportWidth) {
        const overflow = dropdownRect.right - viewportWidth;
        left = Math.max(8, left - overflow - 8);
        this.dropdown.style.left = `${left}px`;
      }

      // Determine vertical position: open upwards if there is not enough space below
      const spaceBelow = viewportHeight - rect.bottom;
      const spaceAbove = rect.top;

      if (spaceBelow < dropdownRect.height + 8 && spaceAbove > spaceBelow) {
        // Open upwards
        this.dropdown.style.top = `${rect.top + window.scrollY - dropdownRect.height - 4}px`;
        this.container.classList.add('open-upward');
      } else {
        // Open downwards
        this.dropdown.style.top = `${rect.bottom + window.scrollY + 4}px`;
        this.container.classList.remove('open-upward');
      }

      this.trigger.setAttribute('aria-expanded', 'true');
      this.container.classList.add('open');

      // Use LayerManager to handle overlay stack and focus
      if (window.LayerManager) {
        window.LayerManager.open(this.dropdown, null, { isPopover: true });
      }

      // Close dropdown if clicked outside
      this.clickOutsideHandler = (e) => {
        if (!this.container.contains(e.target) && !this.dropdown.contains(e.target)) {
          this.close();
        }
      };
      document.addEventListener('click', this.clickOutsideHandler, true);

      // Close dropdown on scroll
      this.scrollHandler = () => {
        this.close();
      };
      window.addEventListener('scroll', this.scrollHandler, { passive: true });
    }

    close() {
      if (!this.isOpen()) return;

      if (window.LayerManager) {
        window.LayerManager.close(this.dropdown);
      }

      if (this.dropdown.parentNode) {
        this.dropdown.parentNode.removeChild(this.dropdown);
      }
      this.trigger.setAttribute('aria-expanded', 'false');
      this.container.classList.remove('open');

      if (this.clickOutsideHandler) {
        document.removeEventListener('click', this.clickOutsideHandler, true);
        this.clickOutsideHandler = null;
      }
      if (this.scrollHandler) {
        window.removeEventListener('scroll', this.scrollHandler);
        this.scrollHandler = null;
      }
    }

    destroy() {
      this.close();
      if (this.observer) this.observer.disconnect();
      if (this.changeHandler) {
        this.selectEl.removeEventListener('change', this.changeHandler);
      }
      
      // Restore properties
      Object.defineProperty(this.selectEl, 'value', Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value'));
      Object.defineProperty(this.selectEl, 'selectedIndex', Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'selectedIndex'));
      
      if (this.container.parentNode) {
        this.container.parentNode.removeChild(this.container);
      }
      this.selectEl.style.removeProperty('display');
      delete this.selectEl.dataset.customSelectInitialized;
      CustomSelect.instances.delete(this);
    }
  }

  CustomSelect.instances = new Set();

  // Helper to initialize custom select on selectors
  CustomSelect.initAll = function(selector) {
    document.querySelectorAll(selector).forEach(CustomSelect.initSingle);
  };

  CustomSelect.initSingle = function(el) {
    // Don't initialize on hidden or special select components
    if (el.dataset.customSelectInitialized ||
        el.style.display === 'none' || 
        el.classList.contains('drp-month-select') || 
        el.classList.contains('drp-year-select') || 
        el.id === 'tl_group') {
      return;
    }
    new CustomSelect(el);
  };

  // Re-sync all instances when language changes
  if (window.i18n && typeof window.i18n.onChange === 'function') {
    window.i18n.onChange(() => {
      CustomSelect.instances.forEach(instance => {
        // Yield to allow translate/i18n.applyDOM to update option text first
        setTimeout(() => {
          instance.sync();
        }, 0);
      });
    });
  }

  global.CustomSelect = CustomSelect;
})(typeof globalThis !== 'undefined' ? globalThis : window);