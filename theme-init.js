(function() {
  try {
    const mode = localStorage.getItem('ado.theme') || 'dark';
    const systemDark = !window.matchMedia || window.matchMedia('(prefers-color-scheme: dark)').matches;
    const light = mode === 'light' || (mode === 'auto' && !systemDark);
    if (light) document.body.classList.add('light');
  } catch(e) {}
})();
