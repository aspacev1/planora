import { useQuery } from "@tanstack/react-query";

import { ORG_QUERY_KEY, organization } from "../api/org";

/**
 * Роли, которым позволено менять проект. Список повторяет матрицу прав
 * сервера — и повторяет её сознательно, а не заменяет: решает всё равно
 * сервер, а здесь решается только то, показывать ли ручку перетаскивания и
 * открывать ли поля на правку.
 *
 * Разница важна: интерфейс, спрятавший кнопку, ничего не защищает — он лишь
 * не предлагает человеку действие, которое всё равно кончится отказом.
 */
const WRITERS = new Set(["owner", "editor"]);

export function roleCanWrite(role: string | undefined | null): boolean {
  return typeof role === "string" && WRITERS.has(role);
}

/**
 * Роли, которым сервер отдаёт коммерческое предложение — ставки и документ
 * для клиента (`Action.PROPOSAL_READ`). Клиенту обещаны сроки и объём, а не
 * то, из чего сложилась цена, и кнопку документа ему не предлагают: она всё
 * равно кончилась бы отказом.
 */
const PROPOSAL_READERS = new Set(["owner", "editor", "viewer"]);

export function roleCanReadProposal(role: string | undefined | null): boolean {
  return typeof role === "string" && PROPOSAL_READERS.has(role);
}

/**
 * Может ли текущий человек менять проекты своей организации.
 *
 * Ключ запроса тот же, что и у шапки, — состав организации не запрашивается
 * второй раз: ответ уже лежит в кэше к моменту, когда экран проекта об этом
 * спросит.
 */
export function useCanWrite(): boolean {
  return roleCanWrite(useOrgRole());
}

/**
 * Роль человека в текущей организации, как её назвал сервер.
 *
 * Нужна там, где двух состояний «может писать или нет» не хватает:
 * переутверждение плана и настройки организации доступны владельцу, а не
 * всякому, кто может двигать полоски.
 */
export function useOrgRole(): string | undefined {
  const org = useQuery({
    queryKey: ORG_QUERY_KEY,
    queryFn: organization,
    retry: false,
    staleTime: Infinity,
  });
  return org.data?.role;
}
