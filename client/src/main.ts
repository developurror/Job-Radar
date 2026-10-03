import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import * as directives from 'vuetify/directives';
import 'vuetify/styles';
import '@mdi/font/css/materialdesignicons.css';
import App from './App.vue';

/** Persisted theme: stored choice wins, otherwise the OS preference. */
export function initialTheme(): 'light' | 'dark' {
  const stored = localStorage.getItem('jobradar-theme');
  if (stored === 'light' || stored === 'dark') return stored;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

const vuetify = createVuetify({
  components,
  directives,
  theme: {
    defaultTheme: initialTheme(),
    themes: {
      light: { dark: false },
      dark: { dark: true },
    },
  },
});

createApp(App).use(createPinia()).use(vuetify).mount('#app');
