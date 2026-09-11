import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useMemo, useRef } from "react";
import type { ReactNode } from "react";

import {
  ME_QUERY_KEY,
  login as loginRequest,
  logout as logoutRequest,
  me,
} from "../api/auth";
import type { LoginInput, User } from "../api/auth";
import { ApiError } from "../api/client";
import { useLocale } from "../i18n/LocaleProvider";

/**
 * There are three states, not two. Without `checking` a route is forced to decide about access
 * before it learns the server's answer — and on every reload a person sees a flash of the sign-in
 * screen even though they signed in long ago.
 */
export type AuthStatus = "checking" | "authenticated" | "anonymous";

type AuthContextValue = {
  user: User | null;
  status: AuthStatus;
  login: (input: LoginInput) => Promise<User>;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const { adoptProfileLocale } = useLocale();

  const query = useQuery({
    queryKey: ME_QUERY_KEY,
    queryFn: me,
    // A retry here would mean "let us keep the person on the indicator for another couple of
    // seconds to get the same 401".
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: Infinity,
  });

  // The cookie is HTTP-only: the client cannot look at whether there is a session — it can only
  // ask the server. Until the answer arrives the state is honestly unknown.
  const user = (query.data as User | null | undefined) ?? null;
  const status: AuthStatus = query.isPending
    ? "checking"
    : user
      ? "authenticated"
      : "anonymous";

  // The profile's language is applied once per sign-in rather than on every profile refresh. The
  // profile is rewritten by the answer to any edit — the name, the zone, the language itself — and
  // the answer to an earlier edit arrives after a later one: a person chose RU, then EN, and the
  // tab went back to RU when the first answer got through. The language choice lives in the
  // switcher (see LocaleSwitch) — what is taken from here is only what the person signed in with.
  const adoptedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!user) {
      adoptedFor.current = null;
      return;
    }
    if (adoptedFor.current === user.id) return;
    adoptedFor.current = user.id;
    adoptProfileLocale(user.locale);
  }, [user, adoptProfileLocale]);

  // The session has ended — the very first request learns about it, rather than the person through
  // a series of refusals. The profile in the cache is invalidated at that, and the protected routes
  // take you to the sign-in themselves (see RequireAuth). What is listened to is the cache rather
  // than every `request` call separately: a 401 arrives at queries and at mutations alike, and each
  // screen has its own error handler, which need not know about the session.
  useEffect(() => {
    const dropSession = (error: unknown) => {
      if (!(error instanceof ApiError) || error.status !== 401) return;
      if (queryClient.getQueryData(ME_QUERY_KEY) == null) return;
      queryClient.setQueryData(ME_QUERY_KEY, null);
    };
    const unsubscribeQueries = queryClient.getQueryCache().subscribe((event) => {
      if (event.type === "updated" && event.action.type === "error") {
        dropSession(event.action.error);
      }
    });
    const unsubscribeMutations = queryClient.getMutationCache().subscribe((event) => {
      if (event.type === "updated" && event.action.type === "error") {
        dropSession(event.action.error);
      }
    });
    return () => {
      unsubscribeQueries();
      unsubscribeMutations();
    };
  }, [queryClient]);

  const loginMutation = useMutation({
    mutationFn: loginRequest,
    onSuccess: (loggedIn: User) => {
      queryClient.setQueryData(ME_QUERY_KEY, loggedIn);
    },
  });

  const logoutMutation = useMutation({
    mutationFn: logoutRequest,
    // On settle rather than on success: signing out must happen even when the server answered with
    // a refusal — the session has already expired, there is no network. Otherwise "Sign out" on an
    // expired session would do nothing, and the person could leave the screen only by reloading.
    onSettled: () => {
      // First the whole cache is thrown out: it holds the departing person's projects, and the next
      // person to sign in on this same tab must not see them even for a frame. The profile is set
      // after the clearing — otherwise the clearing would take it too, and the application would go
      // back into "checking".
      queryClient.clear();
      queryClient.setQueryData(ME_QUERY_KEY, null);
    },
  });

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      status,
      login: (input) => loginMutation.mutateAsync(input),
      // A server refusal on sign-out is swallowed: locally the sign-out has already happened (see
      // onSettled), and there is nothing to report "could not sign out" about to a person who is
      // already on the sign-in screen.
      logout: () =>
        logoutMutation.mutateAsync().then(
          () => undefined,
          () => undefined,
        ),
    }),
    [user, status, loginMutation, logoutMutation],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (value === null) {
    throw new Error("useAuth вызван вне AuthProvider");
  }
  return value;
}
