import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";

// Inter is in the build rather than loaded from a CDN: the install is self-contained and must look the
// same with the internet and without it.
import "@fontsource-variable/inter";
import "./styles.css";
// The Northstar theme: it must come after styles.css — it overrides the tokens, including the dark media
// query (Northstar is light only).
import "./northstar-theme.css";
import { AppRoutes } from "./AppRoutes";
import { AuthProvider } from "./auth/AuthProvider";
import { LocaleProvider } from "./i18n/LocaleProvider";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      {/* The language is outside authentication: the sign-in screen speaks the reader's language too,
          although there is no profile yet. */}
      <LocaleProvider>
        <BrowserRouter>
          <AuthProvider>
            <AppRoutes />
          </AuthProvider>
        </BrowserRouter>
      </LocaleProvider>
    </QueryClientProvider>
  );
}
