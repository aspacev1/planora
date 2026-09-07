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
 * Состояний три, а не два. Без `checking` маршрут вынужден решать про доступ
 * раньше, чем узнал ответ сервера, — и человек при каждой перезагрузке видит
 * вспышку экрана входа, хотя он давно вошёл.
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
    // Повтор здесь означал бы «подержим человека на индикаторе ещё пару
    // секунд, чтобы получить тот же 401».
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: Infinity,
  });

  // Кука HTTP-only: клиент не может посмотреть, есть ли сессия, — он может
  // только спросить сервер. Пока ответа нет, состояние честно неизвестно.
  const user = (query.data as User | null | undefined) ?? null;
  const status: AuthStatus = query.isPending
    ? "checking"
    : user
      ? "authenticated"
      : "anonymous";

  // Язык профиля применяется один раз на вход, а не на каждое обновление
  // профиля. Профиль переписывается ответом любой правки — имени, пояса, самого
  // языка, — и ответ на более раннюю правку приходит позже более поздней:
  // человек выбрал RU, потом EN, а вкладка вернулась на RU, когда доехал
  // первый ответ. Выбор языка живёт в переключателе (см. LocaleSwitch) —
  // отсюда берётся только то, с чем человек вошёл.
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

  // Сессия кончилась — узнаёт об этом первый же запрос, а не человек по
  // череде отказов. Профиль в кэше при этом сбрасывается, и защищённые
  // маршруты уводят на вход сами (см. RequireAuth). Слушается кэш, а не
  // каждый вызов `request` по отдельности: 401 приходит и запросам, и
  // изменениям, и у каждого экрана свой обработчик ошибок, который о сессии
  // знать не обязан.
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
    // По завершении, а не по успеху: выход обязан состояться и тогда, когда
    // сервер ответил отказом — сессия уже просрочена, сети нет. Иначе
    // «Выйти» на просроченной сессии не делало бы ничего, и уйти с экрана
    // человек мог бы только перезагрузкой.
    onSettled: () => {
      // Сначала выбрасывается весь кэш: в нём лежат проекты ушедшего
      // человека, и следующий вошедший на этой же вкладке не должен увидеть
      // их даже на кадр. Профиль ставится после очистки — иначе очистка
      // снесла бы и его, и приложение снова ушло бы в «проверяю».
      queryClient.clear();
      queryClient.setQueryData(ME_QUERY_KEY, null);
    },
  });

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      status,
      login: (input) => loginMutation.mutateAsync(input),
      // Отказ сервера на выходе проглатывается: локально выход уже состоялся
      // (см. onSettled), и сообщать «не удалось выйти» человеку, который уже
      // на экране входа, не о чем.
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
