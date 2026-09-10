import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import {
  AI_CREDENTIAL_QUERY_KEY,
  answerQuestion,
  applySession,
  buildDraft,
  buildSummary,
  editDraft,
  editSummary,
  readCredential,
  startSession,
} from "../api/ai";
import type { AiSession, Draft } from "../api/ai";
import { errorKey } from "../api/errors";
import { useLocale } from "../i18n/LocaleProvider";

/**
 * Создание проекта через интервью.
 *
 * Четыре шага и двое ворот между ними: конспект — где дешевле всего поймать
 * неверно понятое, и черновик — где ещё ничего не записано в проект. Пропустить
 * их нельзя: сервер откажет, а интерфейс и не предлагает.
 */
export function AiIntake() {
  const { t, locale } = useLocale();
  const navigate = useNavigate();
  const [session, setSession] = useState<AiSession | null>(null);
  const [answer, setAnswer] = useState("");

  const credential = useQuery({
    queryKey: AI_CREDENTIAL_QUERY_KEY,
    queryFn: readCredential,
    retry: false,
  });

  const start = useMutation({ mutationFn: () => startSession(locale), onSuccess: setSession });
  const reply = useMutation({
    mutationFn: (text: string) => answerQuestion(session!.id, text),
    onSuccess: (next) => {
      setSession(next);
      setAnswer("");
    },
  });
  const summarize = useMutation({
    mutationFn: () => buildSummary(session!.id),
    onSuccess: setSession,
  });
  const saveTheses = useMutation({
    mutationFn: (theses: string[]) => editSummary(session!.id, theses),
    onSuccess: setSession,
  });
  const draft = useMutation({ mutationFn: () => buildDraft(session!.id), onSuccess: setSession });
  const saveDraft = useMutation({
    mutationFn: (next: Draft) => editDraft(session!.id, next),
    onSuccess: setSession,
  });
  const apply = useMutation({
    mutationFn: (name: string) => applySession(session!.id, name),
    onSuccess: (result) => navigate(`/projects/${result.project_id}`),
  });

  const failure =
    start.error ??
    reply.error ??
    summarize.error ??
    saveTheses.error ??
    draft.error ??
    apply.error ??
    saveDraft.error;

  // Нет ключа — кнопки AI неактивны со ссылкой в настройки. Не спрятаны:
  // спрятанная кнопка не объясняет, почему интервью недоступно.
  if (credential.data && !credential.data.configured) {
    return (
      <main className="screen">
        <div className="screen__head">
          <h1>{t("ai.title")}</h1>
        </div>
        <p>{t("ai.not_configured")}</p>
        <Link to="/settings/organization">{t("nav.org_settings")}</Link>
      </main>
    );
  }

  const question = session?.transcript.at(-1);
  const waiting = session?.status === "interview" && question?.answer === null;

  return (
    <main className="screen">
      <div className="screen__head">
        <h1>{t("ai.title")}</h1>
      </div>

      {failure != null && (
        <p className="error" role="alert">
          {t(errorKey(failure))}
        </p>
      )}

      {session === null && (
        <>
          <p className="muted">{t("ai.intro")}</p>
          <button type="button" onClick={() => start.mutate()} disabled={start.isPending}>
            {t("ai.start")}
          </button>
        </>
      )}

      {session !== null && session.status === "interview" && (
        <section className="settings">
          {/* Вопросы по одному: список из двенадцати полей превращает
              интервью в анкету, которую заполняют не читая. */}
          <p className="ai__question">{question?.question}</p>
          <p className="field">
            <label htmlFor="ai-answer">{t("ai.answer")}</label>
            <textarea
              id="ai-answer"
              name="ai-answer"
              rows={3}
              value={answer}
              onChange={(event) => setAnswer(event.target.value)}
            />
          </p>
          <div className="modal__actions">
            <button
              type="button"
              disabled={answer.trim() === "" || reply.isPending || !waiting}
              onClick={() => reply.mutate(answer.trim())}
            >
              {t("ai.reply")}
            </button>
            {/* Кнопка «хватит, генерируй» доступна на любом шаге: без неё
                человек, которому всё ясно, вынужден досидеть до потолка. */}
            <button
              type="button"
              className="button--quiet"
              onClick={() => summarize.mutate()}
              disabled={summarize.isPending}
            >
              {t("ai.enough")}
            </button>
          </div>
          <p className="muted">
            {t("ai.progress", {
              asked: session.transcript.length,
              tokens: session.tokens_used,
            })}
          </p>
        </section>
      )}

      {session !== null && session.status === "summary" && (
        <SummaryGate
          theses={session.summary}
          pending={saveTheses.isPending || draft.isPending}
          onSave={(theses) => saveTheses.mutate(theses)}
          onNext={() => draft.mutate()}
        />
      )}

      {session !== null && session.status === "draft" && (
        <DraftGate
          draft={session.draft as Draft}
          pending={apply.isPending || saveDraft.isPending}
          onSave={(next) => saveDraft.mutate(next)}
          onApply={(name) => apply.mutate(name)}
        />
      )}
    </main>
  );
}

/** Ворота 1: тезисы правятся и удаляются — на то они и ворота. */
function SummaryGate({
  theses,
  pending,
  onSave,
  onNext,
}: {
  theses: string[];
  pending: boolean;
  onSave: (theses: string[]) => void;
  onNext: () => void;
}) {
  const { t } = useLocale();
  const [text, setText] = useState(theses.join("\n"));

  return (
    <section className="settings">
      <h2>{t("ai.summary.title")}</h2>
      <p className="muted">{t("ai.summary.hint")}</p>
      <p className="field">
        <label htmlFor="ai-theses">{t("ai.summary.theses")}</label>
        <textarea
          id="ai-theses"
          name="ai-theses"
          rows={8}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onBlur={() => {
            const next = text.split("\n").filter((line) => line.trim() !== "");
            if (next.join("\n") !== theses.join("\n")) onSave(next);
          }}
        />
      </p>
      <button type="button" onClick={onNext} disabled={pending}>
        {t("ai.summary.next")}
      </button>
    </section>
  );
}

/** Ворота 2: черновик правится целиком, и в проект не записано ничего. */
function DraftGate({
  draft,
  pending,
  onSave,
  onApply,
}: {
  draft: Draft;
  pending: boolean;
  onSave: (draft: Draft) => void;
  onApply: (name: string) => void;
}) {
  const { t } = useLocale();
  const [name, setName] = useState("");
  // Рабочая копия черновика. Правки идут по ней, а не по пропсу: пропс —
  // это ответ сервера на прошлую правку, и он приходит позже следующей. Две
  // правки подряд — дата у одной задачи, имя у другой, — построенные каждая
  // от пропса, стирали бы друг друга: вторая уходила бы без первой, а
  // последний ответ ставил бы экран в состояние без неё.
  const [work, setWork] = useState(draft);
  useEffect(() => setWork(draft), [draft]);

  const edit = (next: Draft) => {
    setWork(next);
    onSave(next);
  };

  const patchTask = (
    categoryIndex: number,
    taskIndex: number,
    patch: Partial<Draft["categories"][number]["tasks"][number]>,
  ) =>
    edit({
      categories: work.categories.map((category, index) =>
        index !== categoryIndex
          ? category
          : {
              ...category,
              tasks: category.tasks.map((task, position) =>
                position === taskIndex ? { ...task, ...patch } : task,
              ),
            },
      ),
    });

  const dropTask = (categoryIndex: number, taskIndex: number) =>
    edit({
      categories: work.categories.map((category, index) =>
        index !== categoryIndex
          ? category
          : { ...category, tasks: category.tasks.filter((_, position) => position !== taskIndex) },
      ),
    });

  return (
    <section className="settings">
      <h2>{t("ai.draft.title")}</h2>
      <p className="muted">{t("ai.draft.hint")}</p>

      {/* Ключ — номер, а не имя: имена категориям даёт модель, и двум из них
          ничто не мешает совпасть; правки же адресуются номерами. */}
      {work.categories?.map((category, categoryIndex) => (
        <fieldset key={categoryIndex} className="settings__fieldset">
          {/* Название категории — содержимое: пришло от модели на языке
              сессии и не переводится. */}
          <legend>{category.name}</legend>
          <ul className="members__list">
            {category.tasks.map((task, taskIndex) => (
              <li key={`${task.name}-${taskIndex}`} className="members__row">
                <input
                  aria-label={t("ai.draft.task_name", { name: task.name })}
                  defaultValue={task.name}
                  onBlur={(event) =>
                    event.target.value.trim() !== task.name &&
                    patchTask(categoryIndex, taskIndex, { name: event.target.value.trim() })
                  }
                />
                <input
                  type="date"
                  aria-label={t("ai.draft.task_start", { name: task.name })}
                  defaultValue={task.start_date}
                  onChange={(event) =>
                    patchTask(categoryIndex, taskIndex, { start_date: event.target.value })
                  }
                />
                <input
                  type="number"
                  min={1}
                  aria-label={t("ai.draft.task_duration", { name: task.name })}
                  defaultValue={task.duration_days}
                  onBlur={(event) =>
                    patchTask(categoryIndex, taskIndex, {
                      duration_days: Number(event.target.value),
                    })
                  }
                />
                <button
                  type="button"
                  className="button--quiet"
                  onClick={() => dropTask(categoryIndex, taskIndex)}
                >
                  {t("ai.draft.drop")}
                </button>
              </li>
            ))}
          </ul>
        </fieldset>
      ))}

      <p className="field">
        <label htmlFor="ai-project-name">{t("ai.draft.project_name")}</label>
        <input
          id="ai-project-name"
          name="ai-project-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </p>

      <button
        type="button"
        onClick={() => onApply(name.trim())}
        disabled={pending || name.trim() === ""}
      >
        {t("ai.draft.apply")}
      </button>
    </section>
  );
}
