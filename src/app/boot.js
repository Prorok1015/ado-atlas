// Entry point: the DOMContentLoaded bootstrap (i18n init, setup wiring, auth/config
// check, then initialBoot), the console debug hook, and the global smart-paste
// dispatcher (filter-JSON import). Relocated from app.js (bare, no IIFE) as Task D2.
// MUST load LAST — it wires everything at DOMContentLoaded and calls bare into
// app.js/init.js/side-panel.js/setup at runtime (wireSetup, initialBoot, openItem,
// wirePremiumPlaceholders, api, App.setup, projectName, currentUser).
/* ---------- boot ---------- */
async function showPrivacySettingsModal() {
  return new Promise((resolve) => {
    const overlay = document.getElementById('privacy-overlay');
    if (!overlay) {
      resolve('off');
      return;
    }
    overlay.style.display = 'flex';
    overlay.classList.add('show');
    if (window.LayerManager) window.LayerManager.open(overlay, null, { isPopover: true });

    const acceptBtn = document.getElementById('privacy-accept');
    const declineBtn = document.getElementById('privacy-decline');

    const cleanup = (value) => {
      overlay.style.display = 'none';
      overlay.classList.remove('show');
      if (window.LayerManager) window.LayerManager.close(overlay);
      acceptBtn.onclick = null;
      declineBtn.onclick = null;
      document.removeEventListener('keydown', onKey);
      resolve(value);
    };

    const onKey = e => {
      if (e.key === 'Enter') { e.preventDefault(); cleanup('on'); }
      else if (e.key === 'Escape') { e.preventDefault(); cleanup('off'); }
    };

    acceptBtn.onclick = () => { cleanup('on'); };
    declineBtn.onclick = () => { cleanup('off'); };
    document.addEventListener('keydown', onKey);
    acceptBtn.focus();
  });
}

async function checkAiCloudConsent(provider) {
  if (!provider || provider.id === 'chrome-prompt') {
    return true;
  }
  return new Promise((resolve) => {
    chrome.storage.local.get(['ai_cloud_consent_accepted'], (data) => {
      if (data && data.ai_cloud_consent_accepted) {
        resolve(true);
        return;
      }
      
      const overlay = document.getElementById('ai-consent-overlay');
      if (!overlay) {
        resolve(true);
        return;
      }
      
      overlay.style.display = 'flex';
      overlay.classList.add('show');
      if (window.LayerManager) window.LayerManager.open(overlay, null, { isPopover: true });
      
      const okBtn = document.getElementById('ai-consent-ok');
      const cancelBtn = document.getElementById('ai-consent-cancel');
      const dontShowCheck = document.getElementById('ai-consent-dont-show');
      dontShowCheck.checked = false;
      
      const cleanup = (proceed) => {
        overlay.style.display = 'none';
        overlay.classList.remove('show');
        if (window.LayerManager) window.LayerManager.close(overlay);
        okBtn.onclick = null;
        cancelBtn.onclick = null;
        document.removeEventListener('keydown', onKey);
        
        if (proceed && dontShowCheck.checked) {
          chrome.storage.local.set({ ai_cloud_consent_accepted: true }, () => {
            resolve(true);
          });
        } else {
          resolve(proceed);
        }
      };
      
      const onKey = e => {
        if (e.key === 'Enter') { e.preventDefault(); cleanup(true); }
        else if (e.key === 'Escape') { e.preventDefault(); cleanup(false); }
      };
      
      okBtn.onclick = () => { cleanup(true); };
      cancelBtn.onclick = () => { cleanup(false); };
      document.addEventListener('keydown', onKey);
      okBtn.focus();
    });
  });
}

window.showPrivacySettingsModal = showPrivacySettingsModal;
window.checkAiCloudConsent = checkAiCloudConsent;

window.addEventListener('DOMContentLoaded',async()=>{
  if(window.App&&App.prefs){try{await App.prefs.load();}catch(e){}}   // hydrate the prefs cache before anything reads it (i18n/setup/initialBoot)
  if(window.i18n){try{await window.i18n.init();window.i18n.applyDOM();}catch(e){}}
  
  if (App.prefs && App.prefs.get('telemetry') === null) {
    const val = await showPrivacySettingsModal();
    App.prefs.set('telemetry', val);
    if (window.App && App.settings) {
      App.settings.applyTelemetry(val);
    }
  }

  if(App.analytics){try{App.analytics.track('app_open',{lang:window.i18n?window.i18n.getLang():undefined});}catch(e){}}
  wireSetup();
  FollowManager.init(openItem);
  if (window.EntitlementManager) await window.EntitlementManager.init();
  wirePremiumPlaceholders();
  const cfg=await api.getConfig();
  projectName=cfg.project;                  // "no sprint" root path fallback
  const hasAuth=cfg.authMode==='oauth'?(!!cfg.oauthAccess||!!cfg.oauthRefresh):(!!cfg.pat&&!!cfg.org&&!!cfg.project);
  if(!hasAuth){App.setup.showSetup(false);return;}    // first-run flow takes over
  // Validate the stored credentials before showing the UI: a stale token would
  // otherwise surface as a wall of 401s after the first refresh.
  try{
    const name=await api.me();
    if(!name)throw new Error('no display name');
    currentUser=name;
  }catch(e){App.setup.showSetup(false);$('setup-err').textContent='Stored credentials are invalid: '+e.message;return;}
  initialBoot(false);
});

// Debug method to force notifications check from console
window.debugForceNotificationCheck = function() {
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
    console.log("Forcing background notifications check (follows and mentions)...");
    chrome.runtime.sendMessage({ action: "checkMentionsAndFollows" })
      .then((response) => {
        console.log("Response from background check handler:", response);
      })
      .catch((err) => {
        console.warn("Could not check notifications via debug call:", err.message);
      });
  } else {
    console.error("Chrome extension runtime is not available.");
  }
};

// --- Global Smart Paste Dispatcher ---
document.addEventListener('paste', async (e) => {
  // If the user is typing in an input or textarea, let the default behavior happen 
  // unless it's a massive JSON filter payload that they didn't mean to paste as text.
  const activeTag = document.activeElement ? document.activeElement.tagName.toLowerCase() : '';
  const inInput = activeTag === 'input' || activeTag === 'textarea' || (document.activeElement && document.activeElement.isContentEditable);
  
  // 1. Check for text data (Filter JSON)
  const clipboardData = e.clipboardData || window.clipboardData;
  if (!clipboardData) return;
  
  const pastedText = clipboardData.getData('text');
  if (pastedText && pastedText.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(pastedText);
      // Heuristic for our Filter IR schema
      if (parsed && typeof parsed === 'object' && (parsed.where || parsed.cards)) {
        // If pasting directly into the import textarea, let it happen naturally
        if (inInput && document.activeElement.id === 'fb-ie-text') {
          return;
        }
        
        e.preventDefault(); // Intercept!
        
        if (window.FilterBuilderModal && typeof window.FilterBuilderModal.open === 'function') {
          // Open builder with current config to initialize it
          window.FilterBuilderModal.open(window.filterManager ? window.filterManager.getIR() : null, (newIR) => {
            if (window.filterManager) window.filterManager.setIR(newIR);
          });
          
          // Immediately show the import dialog with the pasted text
          if (typeof window.FilterBuilderModal.showImport === 'function') {
             setTimeout(() => {
               window.FilterBuilderModal.showImport(pastedText);
             }, 50);
          }
        }
        return; // Handled
      }
    } catch(err) {
      // Not valid JSON, ignore
    }
  }

  // 2. Check for image data (Screenshots) - Future proofing
  /*
  const items = clipboardData.items;
  for (let i = 0; i < items.length; i++) {
    if (items[i].type.indexOf('image') !== -1) {
      // const blob = items[i].getAsFile();
      // Handle screenshot paste...
      // e.preventDefault();
      // return;
    }
  }
  */
});
