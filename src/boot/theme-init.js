(function() {
  try {
    const savedScale = parseFloat(localStorage.getItem('ado.uiScale')) || 1.0;
    document.documentElement.style.fontSize = (13 * savedScale) + 'px';

    const mode = localStorage.getItem('ado.theme') || 'dark';
    const systemDark = !window.matchMedia || window.matchMedia('(prefers-color-scheme: dark)').matches;
    const light = mode === 'light' || (mode === 'auto' && !systemDark);
    if (light) document.body.classList.add('light');
  } catch(e) {}
})();
