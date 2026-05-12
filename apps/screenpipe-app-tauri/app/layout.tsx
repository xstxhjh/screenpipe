"use client";
import { Inter } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";
import { Toaster } from "@/components/ui/toaster";
import { useEffect } from "react";
import { DeeplinkHandler } from "@/components/deeplink-handler";
import { ShortcutTracker } from "@/components/shortcut-reminder";
import { PipeInstallDialog } from "@/components/pipe-install-dialog";
// TODO: vault lock UI disabled for now — vault is CLI-only until app UX is polished
// import { VaultLockDialog } from "@/components/vault-lock-dialog";
import { usePathname } from "next/navigation";

const inter = Inter({ subsets: ["latin"] });

// Debounced localStorage writer
const createDebouncer = (wait: number) => {
  let timeout: NodeJS.Timeout;
  return (fn: Function) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => fn(), wait);
  };
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const isOverlay = pathname === "/shortcut-reminder";
  const isSearch = pathname === "/search";

  useEffect(() => {
    if (typeof window === "undefined") return;

    // Patch Tauri event listener race condition (APP-2/5/9/W, 69 users)
    // Tauri's unregisterListener doesn't null-check listeners[eventId]
    // causing TypeError when unlisten is called on already-removed listener
    try {
      const internals = (window as any).__TAURI_EVENT_PLUGIN_INTERNALS__;
      if (internals?.unregisterListener) {
        const original = internals.unregisterListener;
        internals.unregisterListener = function(event: string, eventId: number) {
          try {
            return original(event, eventId);
          } catch {
            // listener already removed — race condition, ignore
          }
        };
      }
    } catch {}

    // Focus recovery for Tauri WKWebView (macOS)
    // The webview can silently lose focus, making the entire UI unresponsive
    // to keyboard and sometimes mouse input. Detect and recover by refocusing.
    const callNativeFocusRecovery = () => {
      // Call the Rust-side ensure_webview_focus to re-assert WKWebView
      // as first responder via makeFirstResponder + dispatch_async
      try {
        (window as any).__TAURI_INTERNALS__?.invoke("ensure_webview_focus").catch(() => {});
      } catch {}
    };

    const handleWindowFocus = () => {
      // When the native window regains focus, ensure the webview body is focused
      // so keyboard events work. Small delay to let Tauri finish its focus cycle.
      setTimeout(() => {
        if (document.activeElement === document.body || !document.activeElement) {
          document.body.focus();
        }
        callNativeFocusRecovery();
      }, 50);
    };
    window.addEventListener("focus", handleWindowFocus);

    // Safety valve: click on the app background to force-dismiss stuck overlays
    // by blurring and refocusing — helps when overlays block normal interaction
    const handlePointerRecovery = () => {
      // If there are any fixed z-50 overlays that shouldn't be there,
      // force focus back to body to recover keyboard input
      if (document.activeElement === document.body || !document.activeElement) {
        document.body.tabIndex = -1;
        document.body.focus();
      }
    };
    // Re-check focus on any click — if click reaches window, focus should work
    window.addEventListener("mousedown", handlePointerRecovery, true);

    // Periodic focus watchdog: detect silent focus loss that no event catches.
    // WKWebView can lose first-responder status without firing any JS event
    // (e.g. after native dialog dismiss, tray interaction, or AppKit race).
    // Every 2s, test if a keystroke would reach the webview by checking if
    // the document can receive input. If not, trigger native recovery.
    let lastKeyTime = Date.now();
    const markKeyActivity = () => { lastKeyTime = Date.now(); };
    window.addEventListener("keydown", markKeyActivity, true);

    const focusWatchdog = setInterval(() => {
      // Only check when the window is visible and focused
      if (document.hidden || !document.hasFocus()) return;
      // If we haven't seen a keystroke in 2s and the active element is body
      // (not an input), the WKWebView may have lost first-responder status.
      // Recover quickly — 10s was too long and left typing broken after tray open.
      const now = Date.now();
      const noRecentKeys = now - lastKeyTime > 2_000;
      const activeIsBody = document.activeElement === document.body || !document.activeElement;
      if (noRecentKeys && activeIsBody) {
        callNativeFocusRecovery();
      }
    }, 2_000);

    // Auto-reload on IndexedDB disconnect (APP-2E, 27 users on v2.0.379)
    // WKWebView's IndexedDB server can crash; the page becomes unusable.
    // PostHog JS SDK uses IndexedDB for session replay — this is a known WebKit bug.
    let idbReloadPending = false;
    const handleUnhandledRejection = (e: PromiseRejectionEvent) => {
      const msg = String(e.reason?.message || e.reason || "");
      if (msg.includes("Connection to Indexed Database server lost")) {
        // Prevent the error from reaching Sentry — we handle it via reload
        e.preventDefault();
        if (idbReloadPending) return; // debounce: only one reload
        idbReloadPending = true;
        console.warn("IndexedDB server lost — reloading page in 1s");
        // Short delay to let any in-flight operations settle
        setTimeout(() => window.location.reload(), 1000);
      }
    };
    window.addEventListener("unhandledrejection", handleUnhandledRejection);

    const logs: string[] = [];
    const MAX_LOGS = 1000;
    const originalConsole = { ...console };
    const debouncedWrite = createDebouncer(1000);

    // Belt-and-suspenders: scrub well-known secret-bearing keys before they
    // hit localStorage. Any `console.log(settings)` (recording page, agents,
    // OAuth flows) used to leak deepgramApiKey, aiPresets[].apiKey,
    // openaiCompatibleApiKey, and the user's Clerk JWT into feedback bundles.
    // Scrubbing here means future debug logs can't reintroduce the leak even
    // if someone forgets and dumps an object containing these keys.
    const SECRET_KEYS = new Set([
      "apiKey",
      "deepgramApiKey",
      "openaiCompatibleApiKey",
      "openrouterApiKey",
      "anthropicApiKey",
      "openaiApiKey",
      "geminiApiKey",
      "groqApiKey",
      "elevenLabsApiKey",
      "token",
      "accessToken",
      "refreshToken",
      "idToken",
      "secret",
      "clientSecret",
      "password",
      "authorization",
    ]);
    const stringifyRedacted = (arg: unknown): string => {
      if (typeof arg !== "object" || arg === null) {
        return String(arg);
      }
      try {
        return JSON.stringify(arg, (key, value) => {
          if (
            SECRET_KEYS.has(key) &&
            typeof value === "string" &&
            value.length > 0
          ) {
            return "[redacted]";
          }
          return value;
        });
      } catch {
        return "[unserializable]";
      }
    };

    ["log", "error", "warn", "info"].forEach((level) => {
      (console[level as keyof Console] as any) = (...args: any[]) => {
        // Call original first for performance
        (originalConsole[level as keyof Console] as Function)(...args);

        // Add to memory buffer (with secret keys scrubbed)
        logs.push(
          `[${level.toUpperCase()}] ${args.map(stringifyRedacted).join(" ")}`
        );

        // Trim buffer if needed
        if (logs.length > MAX_LOGS) {
          logs.splice(0, logs.length - MAX_LOGS);
        }

        // Debounced write to localStorage
        debouncedWrite(() => {
          try {
            // localStorage can be null in Tauri WKWebView during navigation
            if (!localStorage) return;
            localStorage.setItem("console_logs", logs.join("\n"));
          } catch (e) {
            try {
              // If localStorage is full, clear half the logs
              logs.splice(0, logs.length / 2);
              if (localStorage) localStorage.setItem("console_logs", logs.join("\n"));
            } catch {
              // localStorage unavailable, skip silently
            }
          }
        });
      };
    });

    return () => {
      window.removeEventListener("focus", handleWindowFocus);
      window.removeEventListener("mousedown", handlePointerRecovery, true);
      window.removeEventListener("keydown", markKeyActivity, true);
      window.removeEventListener("unhandledrejection", handleUnhandledRejection);
      clearInterval(focusWatchdog);
    };
  }, []);

  return (
    <html lang="en" suppressHydrationWarning className={isSearch ? "bg-transparent" : ""}>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `
              (function() {
                // Apply theme to prevent flash and ensure sidebar/main content consistency.
                // Priority: stored preference > system preference
                try {
                  var theme = localStorage.getItem('screenpipe-ui-theme');
                  if (!theme || theme === 'system') {
                    // No preference or 'system' mode: detect system preference for consistent startup
                    theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
                  }
                  document.documentElement.classList.add(theme);
                } catch (e) {
                  // localStorage unavailable, detect system preference as fallback
                  var systemTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
                  document.documentElement.classList.add(systemTheme);
                }

                // Crash recovery: if React fails to render, the page stays blank.
                // After 8s, if <body> has no visible children, reload once.
                var RELOAD_KEY = '__sp_crash_reload';
                setTimeout(function() {
                  var body = document.body;
                  if (!body || body.children.length === 0 || body.offsetHeight === 0) {
                    var last = sessionStorage.getItem(RELOAD_KEY);
                    // Only auto-reload once per 30s to avoid infinite loops
                    if (!last || Date.now() - Number(last) > 30000) {
                      sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
                      window.location.reload();
                    }
                  }
                }, 8000);
              })();
            `,
          }}
        />
        <style dangerouslySetInnerHTML={{ __html: `
          #translate {
            position: fixed !important;
            top: 12px !important;
            right: 12px !important;
            left: auto !important;
            z-index: 999999 !important;
            width: 22px !important;
            height: 22px !important;
            overflow: hidden !important;
            border-radius: 50% !important;
            background: rgba(0,0,0,0.35) !important;
            backdrop-filter: blur(4px) !important;
            box-shadow: none !important;
            padding: 0 !important;
            cursor: pointer !important;
            transition: width 0.3s ease, height 0.3s ease, border-radius 0.3s ease, background 0.2s !important;
            display: flex !important;
            flex-direction: column !important;
            align-items: center !important;
            justify-content: center !important;
          }
          #translate::before {
            content: "\\1F310" !important;
            font-size: 11px !important;
            line-height: 22px !important;
            text-align: center !important;
            flex-shrink: 0 !important;
            pointer-events: none !important;
          }
          #translate select {
            position: absolute !important;
            left: 0 !important;
            top: 0 !important;
            width: 100% !important;
            height: 100% !important;
            opacity: 0 !important;
            cursor: pointer !important;
            font-size: 0 !important;
          }
          #translate:hover {
            width: auto !important;
            height: auto !important;
            min-width: 130px !important;
            border-radius: 11px !important;
            background: rgba(0,0,0,0.55) !important;
            padding: 6px 8px !important;
          }
          #translate:hover::before { display: none !important; }
          #translate:hover select {
            opacity: 1 !important;
            position: relative !important;
            width: 100% !important;
            height: auto !important;
            font-size: 12px !important;
            background: transparent !important;
            color: #fff !important;
            border: none !important;
            outline: none !important;
            padding: 2px 0 !important;
          }
          #translate select option { color: #000 !important; background: #fff !important; }
          #sp-translate-toggle {
            display: none !important;
            width: 100% !important;
            height: 16px !important;
            border-radius: 8px !important;
            border: none !important;
            cursor: pointer !important;
            font-size: 9px !important;
            line-height: 16px !important;
            text-align: center !important;
            padding: 0 !important;
            flex-shrink: 0 !important;
            margin-top: 4px !important;
            background: rgba(255,255,255,0.12) !important;
            color: rgba(255,255,255,0.6) !important;
            transition: background 0.2s, color 0.2s !important;
          }
          #sp-translate-toggle:hover {
            background: rgba(255,255,255,0.2) !important;
            color: #fff !important;
          }
          #sp-translate-toggle.active {
            background: rgba(59,130,246,0.55) !important;
            color: #fff !important;
          }
          #translate:hover #sp-translate-toggle { display: block !important; }
          .dark #translate { background: rgba(255,255,255,0.1) !important; }
          .dark #translate:hover { background: rgba(255,255,255,0.2) !important; }
          .dark #sp-translate-toggle { background: rgba(255,255,255,0.1) !important; }
          .dark #sp-translate-toggle.active { background: rgba(59,130,246,0.5) !important; }
        `}} />
        <script src="https://res.zvo.cn/translate/translate.js" defer></script>
        <script
          dangerouslySetInnerHTML={{
            __html: `
              (function() {
                window.addEventListener('error', function(e) {
                  if (e.message && (e.message.indexOf('translate') !== -1 || e.message.indexOf('Translation') !== -1)) { e.preventDefault(); }
                });
                window.addEventListener('unhandledrejection', function(e) {
                  var msg = String(e.reason && e.reason.message || e.reason || '');
                  if (msg.indexOf('translate') !== -1 || msg.indexOf('Translation') !== -1) { e.preventDefault(); }
                });
                var SP_TRANS_KEY = 'sp_translate_on';
                var SP_LANG_KEY = 'sp_translate_lang';
                function isTranslateOn() {
                  var v = localStorage.getItem(SP_TRANS_KEY);
                  return v === null || v === 'true';
                }
                function setTranslateOn(on) {
                  localStorage.setItem(SP_TRANS_KEY, on ? 'true' : 'false');
                }
                function getSavedLang() {
                  return localStorage.getItem(SP_LANG_KEY) || 'chinese_simplified';
                }
                function saveLang(lang) {
                  localStorage.setItem(SP_LANG_KEY, lang);
                }
                function createToggleButton() {
                  var el = document.getElementById('translate');
                  if (!el || document.getElementById('sp-translate-toggle')) return;
                  var btn = document.createElement('button');
                  btn.id = 'sp-translate-toggle';
                  btn.title = isTranslateOn() ? 'disable translation' : 'enable translation';
                  btn.textContent = isTranslateOn() ? 'ON' : 'OFF';
                  if (isTranslateOn()) btn.classList.add('active');
                  btn.addEventListener('click', function(e) {
                    e.preventDefault();
                    e.stopPropagation();
                    var on = !isTranslateOn();
                    setTranslateOn(on);
                    btn.textContent = on ? 'ON' : 'OFF';
                    btn.title = on ? 'disable translation' : 'enable translation';
                    btn.classList.toggle('active', on);
                    if (on) {
                      var lang = getSavedLang();
                      translate.changeLanguage(lang);
                      var sel = document.getElementById('translateSelectLanguage');
                      if (sel) sel.value = lang;
                    } else {
                      location.reload();
                    }
                  });
                  el.appendChild(btn);
                }
                function initTranslate() {
                  if (typeof translate === 'undefined') {
                    setTimeout(initTranslate, 500);
                    return;
                  }
                  try {
                    translate.storage.set('to','');
                    translate.selectLanguageTag.selectOnChange = function(event){
                      var isReload = translate.to != null && translate.to.length > 0;
                      if(!isReload){
                        var language = event.target.value;
                        saveLang(language);
                        translate.changeLanguage(language);
                        setTranslateOn(true);
                        var btn = document.getElementById('sp-translate-toggle');
                        if(btn){ btn.textContent='ON'; btn.title='disable translation'; btn.classList.add('active'); }
                      }
                    };
                    translate.service.use('client.edge');
                    translate.listener.start();
                    translate.execute();
                    if (isTranslateOn()) {
                      var lang = getSavedLang();
                      setTimeout(function(){
                        translate.changeLanguage(lang);
                        var sel = document.getElementById('translateSelectLanguage');
                        if (sel) sel.value = lang;
                      }, 500);
                    }
                    setTimeout(createToggleButton, 1000);
                    setInterval(function() {
                      if (!document.getElementById('sp-translate-toggle')) createToggleButton();
                    }, 3000);
                  } catch(e) {
                    console.warn('[translate] init error:', e);
                  }
                }
                if(document.readyState === 'complete'){
                  setTimeout(initTranslate, 500);
                } else {
                  window.addEventListener('load', function(){ setTimeout(initTranslate, 500); });
                }
              })();
            `,
          }}
        />
      </head>
      <Providers>
        <body className={`${inter.className} scrollbar-hide ${isSearch ? "bg-transparent" : ""}`}>
          {!isOverlay && <DeeplinkHandler />}
          {!isOverlay && <ShortcutTracker />}
          {!isOverlay && <PipeInstallDialog />}
          {/* TODO: vault lock UI disabled — CLI-only for now */}
          {/* {!isOverlay && <VaultLockDialog />} */}
          {children}
          {!isOverlay && <Toaster />}
        </body>
      </Providers>
    </html>
  );
}
