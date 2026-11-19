// Light / dark / match-system theme. The choice is remembered per browser.
import { h, menu } from './util.js';

const KEY = 'labtex.theme';
const media = window.matchMedia('(prefers-color-scheme: dark)');
const listeners = new Set();

export const themePref = () => { try { return localStorage.getItem(KEY) || 'light'; } catch { return 'light'; } };
export const isDark = () => document.documentElement.dataset.theme === 'dark';

function apply() {
  const pref = themePref();
  const dark = pref === 'dark' || (pref === 'system' && media.matches);
  const changed = isDark() !== dark;
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.querySelectorAll('.theme-btn').forEach(updateButton);
  if (changed) listeners.forEach((fn) => fn(dark));
}

export function setTheme(pref) {
  try { localStorage.setItem(KEY, pref); } catch {}
  apply();
}
/** Call fn(isDark) whenever the effective theme changes. Returns an unsubscribe function. */
export function onThemeChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

media.addEventListener('change', apply);
window.addEventListener('storage', (e) => { if (e.key === KEY) apply(); }); // other tabs
apply();

function updateButton(btn) {
  const dark = isDark();
  btn.textContent = dark ? '☾' : '☀';
  btn.title = `Theme: ${{ light: 'Light', dark: 'Dark', system: 'Match system' }[themePref()]} (click to change)`;
  btn.setAttribute('aria-label', btn.title);
}

/** A ☀/☾ button that opens a Light / Dark / Match system menu. */
export function themeButton() {
  const btn = h('button', {
    class: 'icon-btn theme-btn',
    onclick: (e) => {
      const cur = themePref();
      menu(e.currentTarget, [
        { label: (cur === 'light' ? '✓ ' : '   ') + '☀  Light', onClick: () => setTheme('light') },
        { label: (cur === 'dark' ? '✓ ' : '   ') + '☾  Dark', onClick: () => setTheme('dark') },
        { label: (cur === 'system' ? '✓ ' : '   ') + '◐  Match system', onClick: () => setTheme('system') },
      ]);
    },
  });
  updateButton(btn);
  return btn;
}
