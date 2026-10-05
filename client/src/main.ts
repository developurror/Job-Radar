import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import * as directives from 'vuetify/directives';
import { createVueI18nAdapter } from 'vuetify/locale/adapters/vue-i18n';
import { useI18n } from 'vue-i18n';
import 'vuetify/styles';
import '@mdi/font/css/materialdesignicons.css';
import App from './App.vue';
import { i18n, loadLocaleMessages, resolveInitialLocale } from './i18n';

/** Persisted theme: stored choice wins, otherwise the OS preference. */
export function initialTheme(): 'light' | 'dark' {
  const stored = localStorage.getItem('jobradar-theme');
  if (stored === 'light' || stored === 'dark') return stored;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** Boot: resolve the initial locale and load its catalog before mounting,
 *  so the first paint is already in the right language. */
async function startApp() {
  const initialLocale = resolveInitialLocale();
  await loadLocaleMessages(initialLocale);
  i18n.global.locale.value = initialLocale;
  document.documentElement.lang = initialLocale;

  const vuetify = createVuetify({
    components,
    directives,
    locale: {
      adapter: createVueI18nAdapter({ i18n, useI18n }),
    },
    theme: {
      defaultTheme: initialTheme(),
      themes: {
        light: { dark: false },
        dark: { dark: true },
      },
    },
  });

  createApp(App).use(createPinia()).use(i18n).use(vuetify).mount('#app');
}

void startApp();
