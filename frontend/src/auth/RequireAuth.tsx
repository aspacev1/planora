import { Navigate, Outlet, useLocation } from "react-router-dom";

import { Header } from "../components/Header";
import { ToastProvider } from "../components/toast";
import { VerifyEmailBar } from "../components/VerifyEmailBar";
import { useLocale } from "../i18n/LocaleProvider";
import { useAuth } from "./AuthProvider";

/**
 * The wrapper for protected routes. While the session is being checked it shows an indicator and
 * decides nothing: the decision about access is taken only after the server's answer.
 */
export function RequireAuth() {
  const { status } = useAuth();
  const { t } = useLocale();
  const location = useLocation();

  if (status === "checking") {
    return (
      <main className="screen screen--center">
        <p role="status">{t("common.loading")}</p>
      </main>
    );
  }

  if (status === "anonymous") {
    // The address they were heading for travels with the navigation: links to a project get shared,
    // and a person who opened a link they were sent must see the project after signing in rather
    // than a general list, having forgotten what they came for.
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  // The column and the page are neighbours in one row rather than "a header and everything else":
  // the side navigation must hold the screen's full height, otherwise its background breaks off
  // where the content ends, and the column reads as the page's first block rather than as its frame.
  // The toasts live on the frame rather than on a particular screen: a confirmation with an "Undo"
  // is identically built everywhere something is changed.
  // The "address not confirmed" strip is above the content for the same reason rather than inside a
  // screen: it is about the account rather than about what the person has open right now, and it
  // must catch the eye in any section.
  return (
    <ToastProvider>
      <div className="app">
        <Header />
        <div className="app__main">
          <VerifyEmailBar />
          <Outlet />
        </div>
      </div>
    </ToastProvider>
  );
}
