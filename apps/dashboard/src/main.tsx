import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { adoptLegacyToken } from './api';
import { App } from './App';
import { configureLiveEvents } from './events';
import { I18nProvider } from './i18n';
import { createQueryClient, qk } from './queries';
import { ThemeProvider } from './theme';
import './index.css';

const queryClient = createQueryClient();

configureLiveEvents({
  // The stream came back after a gap: whatever changed meanwhile is reloaded.
  onResync: () => void queryClient.invalidateQueries(),
  // The server closed it (signed out, suspended…): re-check the account, which routes accordingly.
  onRefused: () => void queryClient.invalidateQueries({ queryKey: qk.me }),
});

// Before the first render, so a signed-in user from an older version isn't shown the login page.
await adoptLegacyToken();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <I18nProvider>
          <App />
        </I18nProvider>
      </ThemeProvider>
    </QueryClientProvider>
  </StrictMode>,
);
