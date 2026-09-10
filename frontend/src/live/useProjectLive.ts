import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";

import { commentsQueryKey } from "../api/comments";
import { CONFIG_QUERY_KEY, installConfig } from "../api/config";
import { projectQueryKey } from "../api/projects";
import { proposalQueryKey } from "../api/proposal";

/**
 * Состояние живой связи с проектом.
 *
 * Четыре значения, а не два, и различие между двумя последними — не
 * педантичность:
 *
 * - `connecting` — сокет ещё открывается, состояние только что пришло по HTTP
 *   и свежее; блокировать тут нечего;
 * - `online` — ревизии доезжают сами;
 * - `offline` — связь была и оборвалась. Только здесь показывается полоска и
 *   запирается редактирование: данные на экране устарели неизвестно насколько;
 * - `unavailable` — связи не было ни разу. Так выглядит раскладка без
 *   WebSocket (serverless на Vercel, посредник, режущий upgrade). Живых
 *   обновлений там не будет, но и запирать редактирование не за что: HTTP
 *   работает, и человек не должен получить приложение только для чтения из-за
 *   отсутствия удобства.
 */
export type LiveStatus = "connecting" | "online" | "offline" | "unavailable";

export type Live = { status: LiveStatus };

/**
 * Пауза перед следующей попыткой. Растёт, потому что причина обрыва обычно
 * переживает первую секунду: сервер перезапускают, туннель поднимают, поезд
 * выезжает из тоннеля. Долбить сервер каждую секунду в это время — худшее,
 * что может сделать десяток открытых вкладок.
 */
const RECONNECT_DELAYS = [1000, 2000, 5000, 15000, 30000];

/**
 * Сколько молчания считать обрывом. Сервер напоминает о себе каждые 25 секунд
 * (HEARTBEAT_SECONDS), так что запас — два пропущенных напоминания подряд.
 *
 * Без этого сторожа половина обрывов проходит незамеченной: уснувший ноутбук и
 * сменившаяся сеть не закрывают соединение, а замолкают, и экран продолжает
 * показывать вчерашний план с полной уверенностью в его свежести.
 */
const SILENCE_LIMIT = 60_000;

/** Коды из app/api/live_routes.py. Отказ, а не обрыв: повторять его нечего. */
const CLOSE_UNAUTHENTICATED = 4401;
const CLOSE_NOT_FOUND = 4404;

function liveUrl(projectId: string): string {
  const url = new URL(`/api/projects/${encodeURIComponent(projectId)}/live`, location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function messageType(data: unknown): string | null {
  if (typeof data !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(data);
    return typeof parsed === "object" && parsed !== null && "type" in parsed
      ? String((parsed as { type: unknown }).type)
      : null;
  } catch {
    // Мусор в сокете — не повод падать: соединение живо, а сообщение просто
    // не наше. Молча пропускаем.
    return null;
  }
}

/**
 * Живая лента проекта.
 *
 * Ревизия из сокета — сигнал «состояние изменилось», а не патч: клиент
 * перезапрашивает проект целиком. Второй, «клиентский» применятель операций
 * разошёлся бы с сервером на первом же празднике — даты окончания считает
 * сервер, и повторять его арифметику здесь нечем и незачем.
 */
export function useProjectLive(projectId: string): Live {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<LiveStatus>("connecting");
  // Установка сама говорит, есть ли у неё живая связь (`live_enabled` в
  // /api/config). Читается из кэша, а не спрашивается: настройки установки и
  // так запрашивает рама защищённых экранов, а без них в кэше ответ — «есть»:
  // не открыть сокет там, где он есть, хуже, чем открыть там, где его нет.
  const config = useQuery({ queryKey: CONFIG_QUERY_KEY, queryFn: installConfig, enabled: false });
  const liveEnabled = config.data?.live_enabled ?? true;

  useEffect(() => {
    // Раскладка без WebSocket (serverless): установка знает об этом заранее,
    // и стучаться в сокет шесть раз подряд, чтобы выяснить то же самое, —
    // почти минута лишних попыток на каждое открытие проекта.
    if (typeof WebSocket === "undefined" || !liveEnabled) {
      setStatus("unavailable");
      return;
    }

    let socket: WebSocket | null = null;
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    // Была ли связь хоть раз. Отличает обрыв от «здесь этого не бывает».
    let established = false;
    let stopped = false;

    // Ключ проекта — префикс ключа журнала (см. api/revisions.ts), так что
    // история открытой карточки обновляется тем же сбросом, без отдельного
    // списка ключей, который однажды забудут пополнить.
    const refetch = () => {
      void queryClient.invalidateQueries({ queryKey: projectQueryKey(projectId) });
    };

    const listen = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => socket?.close(), SILENCE_LIMIT);
    };

    const retry = () => {
      // Сокета, который не открылся ни разу, ждать вечно нечего: раскладка без
      // WebSocket не станет с ним со временем. Попытки кончаются, приложение
      // остаётся работоспособным без живых обновлений.
      if (!established && attempt >= RECONNECT_DELAYS.length) return;
      const delay = RECONNECT_DELAYS[Math.min(attempt, RECONNECT_DELAYS.length - 1)];
      attempt += 1;
      reconnect = setTimeout(open, delay);
    };

    function open() {
      if (stopped) return;
      socket = new WebSocket(liveUrl(projectId));

      socket.onopen = () => {
        listen();
        setStatus("online");
        // Восстановление перезапрашивает состояние целиком, а не доигрывает
        // пропущенные ревизии (§12). При первом подключении перезапрашивать
        // нечего: состояние только что пришло по HTTP.
        if (established) refetch();
        established = true;
        attempt = 0;
      };

      socket.onmessage = (message: MessageEvent) => {
        listen();
        const type = messageType(message.data);
        if (type === "revision") refetch();
        // Событие о реплике несёт только факт «в ленте новое» — текст клиент
        // дочитывает по HTTP, где действует фильтр внутренних реплик.
        if (type === "comment") {
          void queryClient.invalidateQueries({ queryKey: commentsQueryKey(projectId) });
        }
        // Смета правится без ревизий, поэтому у неё своё событие — как у
        // реплик: факт «изменилась», текст клиент дочитывает по HTTP.
        if (type === "proposal") {
          void queryClient.invalidateQueries({ queryKey: proposalQueryKey(projectId) });
        }
      };

      socket.onclose = (event: CloseEvent) => {
        clearTimeout(watchdog);
        if (stopped) return;
        setStatus(established ? "offline" : "unavailable");
        // «Не представился» и «нет такого проекта» — ответ, а не помеха:
        // переподключение даст тот же отказ. О просроченной сессии человек
        // узнает от первого же запроса по HTTP, и говорить это дважды не надо.
        if (event.code === CLOSE_UNAUTHENTICATED || event.code === CLOSE_NOT_FOUND) return;
        retry();
      };
    }

    open();

    return () => {
      stopped = true;
      clearTimeout(reconnect);
      clearTimeout(watchdog);
      // onclose снят до закрытия: размонтирование — не обрыв связи, и
      // назначать уходящему экрану статус «нет связи» незачем.
      if (socket) socket.onclose = null;
      socket?.close();
    };
  }, [projectId, queryClient, liveEnabled]);

  // Объект собирается заново на каждый рендер экрана, а через контекст его
  // читает половина дерева: без этого каждая перерисовка проекта тащила бы за
  // собой перерисовку всех потребителей.
  return useMemo(() => ({ status }), [status]);
}
