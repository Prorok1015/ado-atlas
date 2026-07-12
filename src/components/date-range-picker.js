// Localized string helper (guarded: degrades to the English fallback if i18n not ready).
const DRP_L = (k, fallback, p) => (typeof window !== 'undefined' && window.i18n) ? window.i18n.t(k, p) : fallback;
const DRP_WEEKDAY_KEYS = ['dateRange.weekday.mo', 'dateRange.weekday.tu', 'dateRange.weekday.we', 'dateRange.weekday.th', 'dateRange.weekday.fr', 'dateRange.weekday.sa', 'dateRange.weekday.su'];
const DRP_WEEKDAY_EN = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
const DRP_MONTH_KEYS = ['dateRange.month.jan', 'dateRange.month.feb', 'dateRange.month.mar', 'dateRange.month.apr', 'dateRange.month.may', 'dateRange.month.jun', 'dateRange.month.jul', 'dateRange.month.aug', 'dateRange.month.sep', 'dateRange.month.oct', 'dateRange.month.nov', 'dateRange.month.dec'];
const DRP_MONTH_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

class DateRangePicker {
  constructor(containerId, options = {}) {
    this.container = document.getElementById(containerId);
    this.onChange = options.onChange;
    this.single = !!options.single;
    this.start = options.start ? this.parseUtcDate(options.start) : null;
    this.finish = options.finish ? this.parseUtcDate(options.finish) : null;
    if (this.single) {
      this.finish = this.start;
    }
    this.currentMonth = this.start ? new Date(this.start) : new Date();
    this.currentMonth.setUTCDate(1); // Set to start of month in UTC
    this.hoverDate = null;
    this.render();
    // Re-render an open picker when the interface language switches.
    if (typeof window !== 'undefined' && window.i18n && !this._i18nBound) {
      this._i18nBound = true;
      window.i18n.onChange(() => { if (this.container && this.container.isConnected) this.render(); });
    }
  }

  // BCP-47 locale tag for native date formatting (falls back to en-US).
  localeTag() {
    const l = (typeof window !== 'undefined' && window.i18n) ? window.i18n.getLang() : 'en';
    return ({ en: 'en-US', ru: 'ru-RU', es: 'es-ES', de: 'de-DE' })[l] || 'en-US';
  }

  parseUtcDate(str) {
    if (!str) return null;
    const parts = str.slice(0, 10).split('-');
    if (parts.length !== 3) return null;
    return new Date(Date.UTC(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10)));
  }

  formatUtcDate(date) {
    if (!date) return '';
    const y = date.getUTCFullYear();
    const m = String(date.getUTCMonth() + 1).padStart(2, '0');
    const d = String(date.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  setRange(startStr, finishStr) {
    this.start = startStr ? this.parseUtcDate(startStr) : null;
    this.finish = finishStr ? this.parseUtcDate(finishStr) : null;
    if (this.single) {
      this.finish = this.start;
    }
    this.currentMonth = this.start ? new Date(this.start) : new Date();
    this.currentMonth.setUTCDate(1);
    this.hoverDate = null;
    this.render();
  }

  getRange() {
    return {
      start: this.formatUtcDate(this.start),
      finish: this.formatUtcDate(this.finish)
    };
  }

  prevMonth() {
    if (this.viewMode === 'months') {
      this.currentMonth.setUTCFullYear(this.currentMonth.getUTCFullYear() - 1);
    } else if (this.viewMode === 'years') {
      this.currentMonth.setUTCFullYear(this.currentMonth.getUTCFullYear() - 10);
    } else {
      this.currentMonth.setUTCMonth(this.currentMonth.getUTCMonth() - 1);
    }
    this.render();
  }

  nextMonth() {
    if (this.viewMode === 'months') {
      this.currentMonth.setUTCFullYear(this.currentMonth.getUTCFullYear() + 1);
    } else if (this.viewMode === 'years') {
      this.currentMonth.setUTCFullYear(this.currentMonth.getUTCFullYear() + 10);
    } else {
      this.currentMonth.setUTCMonth(this.currentMonth.getUTCMonth() + 1);
    }
    this.render();
  }

  handleDayClick(date) {
    if (this.single) {
      this.start = date;
      this.finish = date;
    } else if (!this.start || (this.start && this.finish)) {
      this.start = date;
      this.finish = null;
    } else {
      if (date < this.start) {
        this.finish = this.start;
        this.start = date;
      } else {
        this.finish = date;
      }
    }
    this.hoverDate = null;
    this.render();
    if (this.onChange) {
      this.onChange(this.getRange());
    }
  }

  handleDayHover(date) {
    if (this.single) return;
    if (this.start && !this.finish) {
      this.hoverDate = date;
      this.renderHoverRange();
    }
  }

  renderHoverRange() {
    const dayElements = this.container.querySelectorAll('.drp-day[data-time]');
    dayElements.forEach(el => {
      const time = parseInt(el.dataset.time, 10);
      el.classList.remove('drp-hover-range', 'drp-hover-finish');
      if (this.start && this.hoverDate && !this.finish) {
        const min = Math.min(this.start.getTime(), this.hoverDate.getTime());
        const max = Math.max(this.start.getTime(), this.hoverDate.getTime());
        if (time > min && time < max) {
          el.classList.add('drp-hover-range');
        }
        if (time === this.hoverDate.getTime() && this.hoverDate.getTime() !== this.start.getTime()) {
          el.classList.add('drp-hover-finish');
        }
      }
    });
  }

  render() {
    this.container.innerHTML = '';
    this.container.classList.add('drp-container');

    if (!this.viewMode) {
      this.viewMode = 'days';
    }

    // Header: Prev Month [Title] Next Month
    const header = document.createElement('div');
    header.className = 'drp-header';

    const prevBtn = document.createElement('button');
    prevBtn.type = 'button';
    prevBtn.className = 'btn btn-sm drp-prev';
    prevBtn.innerHTML = '<ui-icon name="chevron-left"></ui-icon>';
    prevBtn.onclick = () => this.prevMonth();

    const title = document.createElement('span');
    title.className = 'drp-month-title';
    title.style.cursor = 'pointer';
    
    if (this.viewMode === 'days') {
      title.textContent = this.currentMonth.toLocaleString(this.localeTag(), { month: 'long', year: 'numeric', timeZone: 'UTC' });
      title.onclick = () => {
        this.viewMode = 'months';
        this.render();
      };
    } else if (this.viewMode === 'months') {
      title.textContent = this.currentMonth.getUTCFullYear();
      title.onclick = () => {
        this.viewMode = 'years';
        this.render();
      };
    } else if (this.viewMode === 'years') {
      const baseYear = Math.floor(this.currentMonth.getUTCFullYear() / 10) * 10;
      title.textContent = `${baseYear} — ${baseYear + 11}`;
      title.onclick = () => {
        this.viewMode = 'days';
        this.render();
      };
    }

    const nextBtn = document.createElement('button');
    nextBtn.type = 'button';
    nextBtn.className = 'btn btn-sm drp-next';
    nextBtn.innerHTML = '<ui-icon name="chevron-right"></ui-icon>';
    nextBtn.onclick = () => this.nextMonth();

    header.append(prevBtn, title, nextBtn);
    this.container.appendChild(header);

    if (this.viewMode === 'days') {
      // Weekday labels row
      const weekLabels = document.createElement('div');
      weekLabels.className = 'drp-weekdays';
      DRP_WEEKDAY_KEYS.forEach((key, i) => {
        const lbl = document.createElement('div');
        lbl.className = 'drp-weekday';
        lbl.textContent = DRP_L(key, DRP_WEEKDAY_EN[i]);
        weekLabels.appendChild(lbl);
      });
      this.container.appendChild(weekLabels);

      // Grid of days
      const grid = document.createElement('div');
      grid.className = 'drp-grid';

      // Calculate start day offset (Monday-based)
      const temp = new Date(this.currentMonth);
      let startDayOfWeek = temp.getUTCDay(); // 0 = Sunday, 1 = Monday...
      startDayOfWeek = startDayOfWeek === 0 ? 6 : startDayOfWeek - 1; // convert to Mon-based (0 = Mon, 6 = Sun)

      // Previous month empty/filler slots
      for (let i = 0; i < startDayOfWeek; i++) {
        const filler = document.createElement('div');
        filler.className = 'drp-day drp-empty';
        grid.appendChild(filler);
      }

      // Days in active month
      const totalDays = new Date(Date.UTC(this.currentMonth.getUTCFullYear(), this.currentMonth.getUTCMonth() + 1, 0)).getUTCDate();
      const todayStr = this.formatUtcDate(new Date());

      for (let d = 1; d <= totalDays; d++) {
        const date = new Date(Date.UTC(this.currentMonth.getUTCFullYear(), this.currentMonth.getUTCMonth(), d));
        const dateStr = this.formatUtcDate(date);

        const dayCell = document.createElement('div');
        dayCell.className = 'drp-day';
        dayCell.textContent = d;
        dayCell.dataset.time = date.getTime();

        if (dateStr === todayStr) {
          dayCell.classList.add('drp-today');
        }

        const isStart = this.start && this.formatUtcDate(this.start) === dateStr;
        const isFinish = this.finish && this.formatUtcDate(this.finish) === dateStr;

        if (isStart) dayCell.classList.add('drp-start');
        if (isFinish) dayCell.classList.add('drp-finish');
        if (isStart || isFinish) dayCell.classList.add('drp-selected');

        if (this.start && this.finish) {
          if (date > this.start && date < this.finish) {
            dayCell.classList.add('drp-in-range');
          }
        }

        dayCell.onclick = () => this.handleDayClick(date);
        dayCell.onmouseenter = () => this.handleDayHover(date);

        grid.appendChild(dayCell);
      }
      this.container.appendChild(grid);
    } else if (this.viewMode === 'months') {
      const grid = document.createElement('div');
      grid.className = 'drp-grid drp-grid-large';
      DRP_MONTH_KEYS.forEach((key, idx) => {
        const item = document.createElement('div');
        item.className = 'drp-item-large';
        item.textContent = DRP_L(key, DRP_MONTH_EN[idx]);
        if (idx === this.currentMonth.getUTCMonth()) {
          item.classList.add('active');
        }
        item.onclick = () => {
          this.currentMonth.setUTCMonth(idx);
          this.viewMode = 'days';
          this.render();
        };
        grid.appendChild(item);
      });
      this.container.appendChild(grid);
    } else if (this.viewMode === 'years') {
      const grid = document.createElement('div');
      grid.className = 'drp-grid drp-grid-large';
      const baseYear = Math.floor(this.currentMonth.getUTCFullYear() / 10) * 10;
      for (let y = baseYear; y < baseYear + 12; y++) {
        const item = document.createElement('div');
        item.className = 'drp-item-large';
        item.textContent = y;
        if (y === this.currentMonth.getUTCFullYear()) {
          item.classList.add('active');
        }
        item.onclick = () => {
          this.currentMonth.setUTCFullYear(y);
          this.viewMode = 'months';
          this.render();
        };
        grid.appendChild(item);
      }
      this.container.appendChild(grid);
    }

    // Range text display footer
    const footer = document.createElement('div');
    footer.className = 'drp-footer';

    const rangeText = document.createElement('span');
    rangeText.className = 'drp-range-summary';
    const loc = this.localeTag();
    if (this.single) {
      if (this.start) {
        rangeText.textContent = this.start.toLocaleDateString(loc, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
      } else {
        rangeText.textContent = DRP_L('dateRange.selectDate', 'Select date...');
      }
    } else if (this.start || this.finish) {
      const sPart = this.start ? this.start.toLocaleDateString(loc, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '?';
      const fPart = this.finish ? this.finish.toLocaleDateString(loc, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '?';
      rangeText.textContent = `${sPart} — ${fPart}`;
    } else {
      rangeText.textContent = DRP_L('dateRange.selectRange', 'Select date range...');
    }

    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'btn btn-sm drp-clear';
    clearBtn.textContent = DRP_L('dateRange.clear', 'Clear');
    clearBtn.onclick = () => {
      this.start = null;
      this.finish = null;
      this.hoverDate = null;
      this.render();
      if (this.onChange) this.onChange(this.getRange());
    };
    
    footer.append(rangeText, clearBtn);
    this.container.appendChild(footer);

    this.container.onmouseleave = () => {
      this.hoverDate = null;
      this.renderHoverRange();
    };
  }
}
window.DateRangePicker = DateRangePicker;
