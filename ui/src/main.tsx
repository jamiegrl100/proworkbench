import React from 'react';
import ReactDOM from 'react-dom/client';

import App from './App';
import './index.css';
import { LanguageProvider } from './i18n/LanguageProvider';

const THEME_KEY = 'pb_site_theme';

function applyThemeBeforeRender() {
  try {
    const html = document.documentElement;
    let theme = localStorage.getItem(THEME_KEY);
    if (!theme) {
      theme = 'dark';
      localStorage.setItem(THEME_KEY, theme);
    }
    html.classList.remove('dark', 'light');
    html.classList.add(theme === 'light' ? 'light' : 'dark');
  } catch {
    document.documentElement.classList.add('dark');
  }
}

applyThemeBeforeRender();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <LanguageProvider>
      <App />
    </LanguageProvider>
  </React.StrictMode>
);
