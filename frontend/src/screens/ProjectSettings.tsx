import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import { errorKey } from "../api/errors";
import { jiraLinkQueryKey, pushToJira, readJiraLink, syncFromJira } from "../api/jira";
import type { JiraPushFailure } from "../api/jira";
import { ORG_QUERY_KEY, organization } from "../api/org";
import {
  checkProjectSlug,
  getProject,
  projectQueryKey,
  updateProject,
} from "../api/projects";
import type { ProjectState } from "../api/projects";
import { useCanWrite, useOrgRole } from "../auth/permissions";
import { SaveMark, TextField, ValueField, useFieldSaves } from "../components/autosave";
import type { FieldSave } from "../components/autosave";
import { ConfirmAction } from "../components/ConfirmAction";
import { Switch } from "../components/Switch";
import { useToast } from "../components/toast";
import { formatDate, formatTime } from "../i18n/dates";
import { useLocale } from "../i18n/LocaleProvider";
import { SharePanel } from "../project/SharePanel";
import { useDeleteProject } from "../project/useDeleteProject";
import { browserTimeZone, dayIn } from "../time/zone";
import {
  DateListField,
  SlugField,
  WorkingDaysField,
  parseThresholdDays,
} from "../settings/fields";

/**
 * Уровень 3 настроек: слаг, целевая дата и переопределения организации.
 *
 * Переопределение показывается переключателем «наследовать / своё», а не
 * подставленным значением организации: подставленное число выглядит как
 * собственное значение проекта, и человек, поправивший его «обратно как было»,
 * незаметно превращает наследование в копию — ровно то, чего спецификация
 * велит избегать.
 */
export function ProjectSettings() {
  const { t } = useLocale();
  const { projectId = "" } = useParams();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const canWrite = useCanWrite();
  // Удаление проекта — право владельца, как и пересогласование плана:
  // редактор правит настройки, но не расстаётся с проектом целиком. Решает
  // всё равно сервер — здесь лишь не предлагается действие, которое кончится
  // отказом.
  const isOwner = useOrgRole() === "owner";

  const query = useQuery({
    queryKey: projectQueryKey(projectId),
    queryFn: () => getProject(projectId),
    retry: false,
  });
  const org = useQuery({
    queryKey: ORG_QUERY_KEY,
    queryFn: organization,
    retry: false,
    staleTime: Infinity,
  });

  const save = useMutation({
    mutationFn: (patch: Parameters<typeof updateProject>[1]) => updateProject(projectId, patch),
    // Кнопки «Сохранить» здесь нет, поле уходит на сервер по уходу фокуса — и
    // о записи отчитывается само поле, отметкой рядом с ним (см. `SaveMark`).
    // Тостом это говорить нельзя: полей на экране десяток, а тост один и не
    // называет, чьё именно значение доехало.
    onSuccess: (state: ProjectState) =>
      queryClient.setQueryData(projectQueryKey(projectId), state),
  });
  const saves = useFieldSaves(save.mutateAsync);
  // Одна и та же функция между отрисовками: поле слага откладывает проверку
  // по ней, и новая стрелка на каждую отрисовку экрана — а он перерисовывается
  // на каждом ответе любого поля — сбрасывала бы таймер и выбрасывала уже
  // полученный ответ, так что подсказка «занято» не появлялась вовсе.
  const checkSlug = useCallback((slug: string) => checkProjectSlug(projectId, slug), [projectId]);

  // Что делается с кэшем после удаления, знает общий хук: то же самое
  // случается и при удалении с карточки в списке проектов. Экрану остаётся
  // своё — уйти оттуда, где больше нечего показывать. replace, а не push:
  // «назад» к настройкам удалённого проекта вело бы на экран, которому нечего
  // показать, кроме ошибки.
  const remove = useDeleteProject({
    onDeleted: () => navigate("/projects", { replace: true }),
  });

  if (query.isPending) {
    return (
      <main className="screen">
        <p role="status">{t("common.loading")}</p>
      </main>
    );
  }

  if (query.error) {
    return (
      <main className="screen">
        <p className="error" role="alert">
          {t(errorKey(query.error))}
        </p>
      </main>
    );
  }

  const state = query.data;
  const overrides = state.overrides;
  const orgSettings = org.data?.settings;
  const readOnly = !canWrite;

  return (
    <main className="screen">
      <div className="screen__head">
        {/* Название проекта — содержимое пользователя: не переводится. */}
        <h1>{t("settings.project.title", { name: state.name })}</h1>
        <Link to={`/projects/${projectId}`}>{t("settings.project.back")}</Link>
      </div>

      <section className="settings">
        <TextField
          id="project-name"
          label={t("settings.project.name")}
          value={state.name}
          disabled={readOnly}
          save={saves.at("project-name")}
          onCommit={(value) => saves.commitText("project-name", value, (name) => ({ name }))}
        />

        <SlugField
          id="project-slug"
          label={t("settings.project.slug")}
          value={state.slug}
          disabled={readOnly}
          check={checkSlug}
          save={saves.at("project-slug")}
          onCommit={(slug) => saves.commit("project-slug", { slug })}
        />

        <ValueField
          id="project-deadline"
          label={t("settings.project.deadline")}
          type="date"
          value={state.deadline ?? ""}
          disabled={readOnly}
          // Пустая дата — это отсутствие дедлайна, а не пропуск поля.
          allowEmpty
          save={saves.at("project-deadline")}
          onCommit={(value) =>
            saves.commit("project-deadline", { deadline: value === "" ? null : value })
          }
        />

        <Override
          id="project-timezone"
          label={t("settings.timezone")}
          inherited={orgSettings?.default_timezone ?? ""}
          overridden={overrides?.timezone ?? null}
          disabled={readOnly}
          save={saves.at("project-timezone")}
          onInherit={() => saves.commit("project-timezone", { timezone: null })}
          onOverride={(value) =>
            saves.commitText("project-timezone", value, (zone) => ({ timezone: zone }))
          }
          render={(value, onCommit, disabled, save) => (
            <TextField
              id="project-timezone"
              labelledBy="project-timezone-label"
              value={value}
              disabled={disabled}
              save={save}
              onCommit={onCommit}
            />
          )}
        />

        <Override
          id="project-threshold"
          label={t("settings.threshold")}
          inherited={String(orgSettings?.default_shift_threshold_days ?? "")}
          overridden={
            overrides?.shift_threshold_days === null || overrides === undefined
              ? null
              : String(overrides.shift_threshold_days)
          }
          disabled={readOnly}
          save={saves.at("project-threshold")}
          onInherit={() => saves.commit("project-threshold", { shift_threshold_days: null })}
          // Пустое поле — не «порог ноль»: пока числа нет, переопределение
          // остаётся прежним, а не превращается в «объяснять каждый сдвиг».
          // Разбор общий с настройками организации (см. `parseThresholdDays`).
          onOverride={(value) =>
            saves.commitNumber(
              "project-threshold",
              value,
              (days) => ({ shift_threshold_days: days }),
              parseThresholdDays,
            )
          }
          render={(value, onCommit, disabled, save) => (
            <TextField
              id="project-threshold"
              labelledBy="project-threshold-label"
              type="number"
              min={0}
              value={value}
              disabled={disabled}
              save={save}
              onCommit={onCommit}
            />
          )}
        />

        <Override
          id="project-working-days"
          label={t("settings.working_days")}
          inherited={String(orgSettings?.working_days ?? "")}
          overridden={
            overrides?.working_days === null || overrides === undefined
              ? null
              : String(overrides.working_days)
          }
          disabled={readOnly}
          save={saves.at("project-working-days")}
          onInherit={() => saves.commit("project-working-days", { working_days: null })}
          onOverride={(value) =>
            saves.commit("project-working-days", { working_days: Number(value) })
          }
          render={(value, onCommit, disabled, save) => (
            <WorkingDaysField
              value={Number(value) || state.calendar.working_days}
              disabled={disabled}
              save={save}
              onChange={(mask) => onCommit(String(mask))}
            />
          )}
        />

        <DateListField
          id="project-holidays"
          label={t("settings.project.holidays_extra")}
          hint={t("settings.project.holidays_extra_hint")}
          value={overrides?.holidays_extra ?? []}
          disabled={readOnly}
          save={saves.at("project-holidays")}
          onCommit={(holidays_extra) => saves.commit("project-holidays", { holidays_extra })}
        />

        {/* Автоперенос — рубильник, а не переопределение: у организации такой
            настройки нет вовсе, наследовать нечего. Стоит рядом с календарём,
            потому что отвечает на тот же вопрос — по каким правилам считаются
            даты, — а не «какие они». */}
        <p className="field">
          <Switch
            id="project-auto-schedule"
            label={t("gantt.auto_schedule.label")}
            checked={state.auto_schedule === true}
            disabled={readOnly}
            onChange={(auto_schedule) =>
              saves.commit("project-auto-schedule", { auto_schedule })
            }
          />
          <span className="muted">{t("gantt.auto_schedule.hint")}</span>
          <SaveMark save={saves.at("project-auto-schedule")} />
        </p>

        <DateListField
          id="project-workdays"
          label={t("settings.project.workdays_extra")}
          hint={t("settings.project.workdays_extra_hint")}
          value={overrides?.workdays_extra ?? []}
          disabled={readOnly}
          save={saves.at("project-workdays")}
          onCommit={(workdays_extra) => saves.commit("project-workdays", { workdays_extra })}
        />

        {/* Jira — только у проекта, заведённого импортом: у обычного проекта
            эту панель просто нечем заполнить. */}
        <JiraSyncPanel projectId={projectId} readOnly={readOnly} />

        {/* Публичная ссылка — последним блоком: это не настройка расчёта, а
            решение показать проект наружу. */}
        {!readOnly && <SharePanel projectId={projectId} />}

        {/* Удаление — после всего остального: это не настройка, а расставание
            с проектом. Подтверждение разворачивается на месте, как у
            пересогласования плана, — и предупреждает честно: вместе с
            проектом уходит журнал ревизий, то есть и возможность отмены. */}
        {isOwner && (
          <div className="settings__danger">
            {remove.error !== null && (
              <p className="error" role="alert">
                {t(errorKey(remove.error))}
              </p>
            )}
            <ConfirmAction
              className="button--quiet button--alert"
              label={t("settings.project.delete")}
              warning={t("settings.project.delete_warning")}
              confirm={t("settings.project.delete_confirm")}
              onConfirm={() => remove.mutate({ id: projectId, name: state.name })}
              disabled={remove.isPending}
            />
          </div>
        )}
      </section>
    </main>
  );
}

/**
 * Значение, которое либо наследуется, либо задано этим проектом.
 *
 * Переключатель стоит прежде самого поля намеренно: сперва решается, чьё это
 * значение, и только потом — какое. Обратный порядок предлагал бы править
 * число, которое проекту не принадлежит.
 */
function Override({
  id,
  label,
  inherited,
  overridden,
  disabled,
  save,
  onInherit,
  onOverride,
  render,
}: {
  id: string;
  label: string;
  /** Значение организации — то, что действует, пока переопределения нет. */
  inherited: string;
  /** `null` — наследуется. */
  overridden: string | null;
  disabled?: boolean;
  save?: FieldSave;
  onInherit: () => void;
  onOverride: (value: string) => void;
  render: (
    value: string,
    onCommit: (value: string) => void,
    disabled: boolean,
    save?: FieldSave,
  ) => React.ReactNode;
}) {
  const { t } = useLocale();
  const inherits = overridden === null;

  return (
    <div className="settings__override">
      <span className="settings__override-label" id={`${id}-label`}>
        {label}
      </span>
      <label className="settings__inherit">
        <input
          type="checkbox"
          checked={inherits}
          disabled={disabled}
          onChange={(event) => (event.target.checked ? onInherit() : onOverride(inherited))}
        />
        {t("settings.inherit", { value: inherited })}
      </label>
      {/* Отметка об отправке — там, где стоит орган управления: пока значение
          наследуется, это сама галочка, а дальше её показывает поле. Иначе о
          возврате к наследованию не сказал бы никто. */}
      {inherits ? <SaveMark save={save} /> : render(overridden, onOverride, Boolean(disabled), save)}
    </div>
  );
}

/**
 * Синхронизация с Jira — только у проекта, заведённого импортом.
 *
 * Молчит (не рисует ничего), если проект обычный: пустая панель с надписью
 * «не привязан» отвечала бы на вопрос, который никто не задавал, — у
 * обычного проекта Jira просто нет отношения к делу.
 */
function JiraSyncPanel({ projectId, readOnly }: { projectId: string; readOnly: boolean }) {
  const { t, locale } = useLocale();
  const queryClient = useQueryClient();
  // День и время рядом обязаны считаться по одним часам: время — по часам
  // машины (см. formatTime), и день берётся по ним же, а не обрезкой
  // ISO-строки по UTC, иначе ночная синхронизация датировалась бы вчерашним
  // числом рядом с сегодняшним временем.
  const zone = browserTimeZone();
  const showToast = useToast();
  // Отказы отправки остаются на панели, а не только в тосте: тост исчезает,
  // а список отклонённых задач Jira — то, что человеку нужно решить, а не
  // просто прочитать один раз.
  const [pushFailures, setPushFailures] = useState<JiraPushFailure[]>([]);

  const link = useQuery({
    queryKey: jiraLinkQueryKey(projectId),
    queryFn: () => readJiraLink(projectId),
    retry: false,
  });

  const sync = useMutation({
    mutationFn: () => syncFromJira(projectId),
    onSuccess: (result) => {
      // Ревизии применились в базе — состояние проекта (задачи, диаграмма,
      // скоркард) читают его заново, а не достраивают поверх кэша: строк
      // могло появиться сколько угодно, и досчитывать разницу на клиенте —
      // повторять то, что уже посчитал сервер.
      void queryClient.invalidateQueries({ queryKey: projectQueryKey(projectId) });
      queryClient.setQueryData(jiraLinkQueryKey(projectId), {
        ...link.data,
        last_synced_at: new Date().toISOString(),
      });
      showToast({
        message: t("jira.sync.result", {
          createdTasks: result.created_tasks,
          updatedTasks: result.updated_tasks,
        }),
      });
    },
  });

  const push = useMutation({
    mutationFn: () => pushToJira(projectId),
    onSuccess: (result) => {
      setPushFailures(result.failed);
      showToast({
        message: t(
          result.failed.length > 0 ? "jira.push.result_with_failures" : "jira.push.result",
          { pushed: result.pushed, unchanged: result.unchanged, failed: result.failed.length },
        ),
      });
    },
  });

  if (!link.data?.linked) return null;

  return (
    <div className="settings__fieldset">
      <h2>{t("jira.sync.title")}</h2>
      <p className="muted">{t("jira.sync.hint", { key: link.data.jira_project_key ?? "" })}</p>
      <p className="muted">
        {link.data.last_synced_at
          ? t("jira.sync.last_synced", {
              date: `${formatDate(t, dayIn(zone, new Date(link.data.last_synced_at)))} · ${formatTime(locale, new Date(link.data.last_synced_at))}`,
            })
          : t("jira.sync.never")}
      </p>

      {sync.error !== null && (
        <p className="error" role="alert">
          {t(errorKey(sync.error))}
        </p>
      )}

      <button type="button" disabled={readOnly || sync.isPending} onClick={() => sync.mutate()}>
        {t("jira.sync.button")}
      </button>

      <p className="muted">{t("jira.push.hint")}</p>

      {push.error !== null && (
        <p className="error" role="alert">
          {t(errorKey(push.error))}
        </p>
      )}

      {pushFailures.length > 0 && (
        <p className="error" role="alert">
          {t("jira.push.failures", { keys: pushFailures.map((f) => f.issue_key).join(", ") })}
        </p>
      )}

      <button type="button" disabled={readOnly || push.isPending} onClick={() => push.mutate()}>
        {t("jira.push.button")}
      </button>
    </div>
  );
}
