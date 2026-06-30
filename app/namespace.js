// Bootstrap for the App.* modular front-end (see REFACTORING_PLAN.md).
// Must load FIRST among app/*.js so every later module can attach to App.
// No-bundler: classic <script> in the shared global scope, like components/*.
window.App = window.App || {};
