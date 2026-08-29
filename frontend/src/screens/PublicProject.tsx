import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";

import { errorKey } from "../api/errors";
import { useAuth } from "../auth/AuthProvider";
import {
  addPublicComment,
  getPublicProject,
  listPublicCommentCounts,
  listPublicComments,
  publicCommentCountsQueryKey,
  publicCommentsQueryKey,
  publicProjectQueryKey,
} from "../api/public";
import type { PublicProjectState } from "../api/public";
import { exportPublicProject } from "../api/export";
import { CommentThread } from "../comments/CommentThread";
import { IconDownload } from "../components/icons";
import { ExportDialog } from "../export/ExportDialog";
import { LocaleSwitch } from "../components/LocaleSwitch";
import { Gantt } from "../gantt/Gantt";
import { usePrefersReducedMotion } from "../gantt/motion";
import { useLocale } from "../i18n/LocaleProvider";
import type { ExportFacts } from "../export/ExportDialog";
import { ProjectHead } from "../project/ProjectHead";

/**
 * Проект, открытый по публичной ссылке.
 *
 * Та же диаграмма, что и на рабочем экране, но только на чтение: `canWrite`
 * здесь не выключен «пока что», его неоткуда взять — у гостя нет ни сессии,
 * ни роли. Внутренних заметок и исполнителей в ответе сервера нет вовсе, и
 * прятать их разметке не приходится.
 *
 * Переключатель языка стоит прямо на странице: клиент может не совпадать по
 * языку с командой, а профиля, из которого можно было бы взять язык, у него
 * нет.
 */
export function PublicProject() {
  const { t } = useLocale();
  const { orgSlug = "", projectSlug = "" } = useParams();
  const [searchParams] = useSearchParams();
  const [exporting, setExporting] = useState(false);
  const token = searchParams.get("s") ?? "";
  const queryClient = useQueryClient();
  const reducedMotion = usePrefersReducedMotion();

  const project = useQuery({
    queryKey: publicProjectQueryKey(orgSlug, projectSlug, token),
    queryFn: () => getPublicProject(orgSlug, projectSlug, token),
    retry: false,
  });

  const comments = useQuery({
    queryKey: publicCommentsQueryKey(orgSlug, projectSlug, token),
    queryFn: () => listPublicComments(orgSlug, projectSlug, token),
    retry: false,
    // Лента спрашивается только тогда, когда страница открылась: до этого
    // токен может оказаться нерабочим, и второй запрос принесёт вторую
    // ошибку об одном и том же.
    enabled: project.isSuccess,
  });

  // Число реплик на строках — без внутренних: их фильтрует сервер, а не
  // разметка. Ключ лежит внутри ключа ленты, поэтому своя же отправленная
  // реплика обновляет и счётчик — тем же сбросом, что и саму ленту.
  const counts = useQuery({
    queryKey: publicCommentCountsQueryKey(orgSlug, projectSlug, token),
    queryFn: () => listPublicCommentCounts(orgSlug, projectSlug, token),
    retry: false,
    enabled: project.isSuccess,
  });
  const commentsByTask = useMemo(
    () => new Map(Object.entries(counts.data ?? {})),
    [counts.data],
  );

  const send = useMutation({
    mutationFn: (input: { body: string; name: string }) =>
      addPublicComment(orgSlug, projectSlug, token, { name: input.name, body: input.body }),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: publicCommentsQueryKey(orgSlug, projectSlug, token),
      }),
  });

  if (project.isPending) {
    return (
      <>
        {/* Шапка стоит и здесь: она не часть проекта, а рама страницы — с
            входом и переключателем языка, которые нужны раньше, чем приедет
            содержимое. Название организации пока не пришло, и его место
            держит название продукта, а не пустота, от которой строка потом
            дёрнулась бы по высоте. */}
        <PublicHeader title={t("app.title")} />
        <main className="screen screen--center">
          <p role="status">{t("common.loading")}</p>
        </main>
      </>
    );
  }

  if (project.error) {
    // Отозванная ссылка, опечатка в адресе и несуществующий проект приходят
    // одним и тем же отказом: сервер их не различает сознательно, и
    // придумывать здесь разницу нельзя.
    return (
      <>
        {/* И здесь тоже: отозванную ссылку чаще всего открывает свой же — тот,
            кто эту ссылку и рассылал. Ему нужен вход, а не только сообщение о
            том, что дальше хода нет. */}
        <PublicHeader title={t("app.title")} />
        <main className="screen screen--center">
          <p className="error" role="alert">
            {t(errorKey(project.error))}
          </p>
        </main>
      </>
    );
  }

  return (
    <>
      <PublicHeader title={project.data.org.name} projectId={project.data.id} />

      <main className="screen screen--wide">
        {/* Та же шапка, что и на рабочем экране, но без действий и без строки
            плана: клиенту по ссылке обещаны сроки и объём, а не версия
            согласования и внутренние расхождения с ней. */}
        {/* Выгрузка гостю доступна: тот же урез, что он видит на экране, —
            без базового плана, исполнителей и внутренних реплик. Отказать в
            ней значило бы запретить сохранить то, что и так показано. */}
        <ProjectHead
          state={project.data}
          actions={
            <button
              type="button"
              className="button--quiet"
              onClick={() => setExporting(true)}
            >
              <IconDownload />
              {t("export.open")}
            </button>
          }
        />

        {exporting && (
          <ExportDialog
            facts={publicFacts(project.data)}
            onClose={() => setExporting(false)}
            download={(options) =>
              exportPublicProject(orgSlug, projectSlug, searchParams.toString(), options)
            }
          />
        )}

        <div className={`project__body${reducedMotion ? " motion-off" : ""}`}>
          {/* Счётчик реплик виден и гостю — но кнопкой не становится:
              карточки задачи у него нет, и открывать ею нечего (см. Row).
              Знать, что об этой строке уже говорили, ему всё равно полезно:
              разговор идёт лентой ниже. */}
          <Gantt
            projectId={project.data.id}
            state={project.data}
            canWrite={false}
            commentCounts={commentsByTask}
          />
        </div>

        <CommentThread
          comments={comments.data ?? []}
          loading={comments.isPending}
          error={comments.error}
          askName
          canComment={project.data.comments_enabled}
          onSend={(input) => send.mutateAsync(input)}
          sending={send.isPending}
          sendError={send.error}
        />
      </main>
    </>
  );
}

/**
 * Шапка страницы по ссылке — и единственный ход отсюда в само приложение.
 *
 * Публичную ссылку открывает не только клиент: по ней ходит и своя команда, и
 * тот, кто её разослал. Раньше шапка держала подпись «публичная страница» и
 * переключатель языка, и человек, оказавшийся здесь, никакого пути внутрь не
 * видел вовсе — адрес входа приходилось знать наизусть.
 *
 * Что предложить, решает сессия, а не догадка:
 *
 * — гостю «Войти», и после входа он попадает в этот же проект, а не в общий
 *   список: он пришёл по ссылке именно на него, и терять её на шаге с паролем
 *   значило бы заставить искать проект заново. Чужому аккаунту проект ответит
 *   тем же отказом, что и всегда: ссылка открывает страницу, а не доступ, и
 *   решать про доступ шапке нечем;
 * — вошедшему «Открыть в приложении»: предлагать ему вход — это спрашивать
 *   пароль у того, кто уже вошёл;
 * — пока сессия проверяется — ничего: показать «Войти» и через мгновение
 *   заменить его другой ссылкой хуже, чем показать её мгновением позже.
 *
 * Ссылка-кнопка, а не подчёркнутое слово: рядом стоят подпись «публичная
 * страница» и переключатель языка, и среди слов слово потерялось бы.
 */
function PublicHeader({ title, projectId }: { title: string; projectId?: string }) {
  const { t } = useLocale();
  const { status } = useAuth();
  // Адрес проекта известен только тогда, когда проект открылся: на отозванной
  // ссылке возвращаться после входа некуда, и человек попадает туда же, куда
  // приводит обычный вход, — в список проектов.
  const inApp = projectId === undefined ? null : `/projects/${projectId}`;

  return (
    <header className="header">
      <span className="header__brand">{title}</span>
      <div className="header__side">
        <span className="muted">{t("public.badge")}</span>
        <LocaleSwitch />
        {status === "anonymous" && (
          <Link
            className="button-link"
            to="/login"
            // Тем же способом, каким помнит адрес `RequireAuth`: экран входа
            // читает его из состояния перехода (см. afterAuthPath).
            state={inApp === null ? undefined : { from: { pathname: inApp } }}
          >
            {t("public.login")}
          </Link>
        )}
        {status === "authenticated" && (
          <Link className="button-link" to={inApp ?? "/projects"}>
            {t("public.open_app")}
          </Link>
        )}
      </div>
    </header>
  );
}


/**
 * Что предлагать гостю в окне выгрузки.
 *
 * Считается из того же состояния, что нарисовано на экране, а не запросом:
 * маршрута `export/facts` у публичной страницы нет — и заводить его значило бы
 * отдать наружу счётчики разделов, которых гость всё равно не увидит.
 *
 * Смета, скоркард и журнал правок ему не предлагаются вовсе — по тому же
 * правилу, что действует на сервере: выгрузка не показывает больше, чем
 * показывает страница, с которой её позвали (см. INTERNAL_SECTIONS).
 */
function publicFacts(state: PublicProjectState): ExportFacts {
  const starts = state.tasks.map((task) => task.start_date).sort();
  return {
    projectName: state.name,
    start: starts[0] ?? state.start_date ?? new Date().toISOString().slice(0, 10),
    end: state.project_end ?? starts[starts.length - 1] ?? new Date().toISOString().slice(0, 10),
    // «Сегодня» у гостя — браузерное: часового пояса проекта публичная выдача
    // не несёт. На числе страниц это не сказывается: окна отсчитываются
    // сутками, и разница в пояс их не сдвигает.
    today: new Date().toISOString().slice(0, 10),
    dated: state.schedule_mode === "calendar",
    tasks: state.tasks.length,
    categories: state.categories.length,
    links: state.dependencies.length,
    comments: 0,
    proposalLines: 0,
    scorecardMetrics: 0,
    historyEvents: 0,
    internalAllowed: false,
  };
}
