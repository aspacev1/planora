import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { errorKey } from "../api/errors";
import {
  JIRA_CREDENTIAL_QUERY_KEY,
  JIRA_PROJECTS_QUERY_KEY,
  importFromJira,
  listJiraProjects,
  readJiraCredential,
} from "../api/jira";
import { PROJECTS_QUERY_KEY } from "../api/projects";
import { Field } from "../components/Field";
import { useToast } from "../components/toast";
import { useLocale } from "../i18n/LocaleProvider";

/**
 * Importing a project from Jira: a screen rather than a dialog over the list of projects.
 *
 * The same choice as with the AI interview (/projects/new/ai): creating a project is not a fleeting
 * action that can be folded into a dialog but a separate step with its own loading state — first the
 * list of Jira projects, then the import itself — and the screen's address survives a page reload.
 */
export function JiraImport() {
  const { t } = useLocale();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const showToast = useToast();

  const credential = useQuery({
    queryKey: JIRA_CREDENTIAL_QUERY_KEY,
    queryFn: readJiraCredential,
    retry: false,
  });
  const configured = credential.data?.configured === true;

  const projects = useQuery({
    queryKey: JIRA_PROJECTS_QUERY_KEY,
    queryFn: listJiraProjects,
    enabled: configured,
    retry: false,
  });

  const [projectKey, setProjectKey] = useState("");
  const [name, setName] = useState("");
  // The name was typed by hand — choosing a different Jira project no longer overwrites the field on top
  // of what the person has already corrected.
  const [nameTouched, setNameTouched] = useState(false);

  const importMutation = useMutation({
    mutationFn: () => importFromJira({ jira_project_key: projectKey, name: name.trim() }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: PROJECTS_QUERY_KEY });
      navigate(`/projects/${result.project_id}`);
      showToast({ message: t("jira.import.imported", { name: name.trim() }) });
    },
  });

  if (credential.isPending) {
    return (
      <main className="screen">
        <p role="status">{t("common.loading")}</p>
      </main>
    );
  }

  return (
    <main className="screen">
      <div className="screen__head">
        <h1>{t("jira.import.title")}</h1>
        <Link to="/projects">{t("jira.import.back")}</Link>
      </div>

      {credential.error && (
        <p className="error" role="alert">
          {t(errorKey(credential.error))}
        </p>
      )}

      {/* Not hidden: a hidden form does not explain why the import is unavailable — by the same rule as
          with the AI interview. */}
      {!configured && !credential.error && (
        <>
          <p>{t("jira.not_configured")}</p>
          <Link to="/settings/organization">{t("nav.org_settings")}</Link>
        </>
      )}

      {configured && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            importMutation.mutate();
          }}
        >
          {projects.isPending && <p role="status">{t("jira.import.loading_projects")}</p>}

          {projects.error && (
            <p className="error" role="alert">
              {t(errorKey(projects.error))}
            </p>
          )}

          {projects.data && projects.data.length === 0 && (
            <p className="muted">{t("jira.import.empty_projects")}</p>
          )}

          {projects.data && projects.data.length > 0 && (
            <>
              <p className="field">
                <label htmlFor="jira-import-project">{t("jira.import.project_label")}</label>
                <select
                  id="jira-import-project"
                  value={projectKey}
                  onChange={(event) => {
                    const key = event.target.value;
                    setProjectKey(key);
                    if (!nameTouched) {
                      const picked = projects.data.find((project) => project.key === key);
                      setName(picked?.name ?? "");
                    }
                  }}
                >
                  <option value="">{t("jira.import.project_placeholder")}</option>
                  {projects.data.map((project) => (
                    <option key={project.key} value={project.key}>
                      {project.key} — {project.name}
                    </option>
                  ))}
                </select>
              </p>

              <Field
                id="jira-import-name"
                label={t("jira.import.name_label")}
                value={name}
                onChange={(value) => {
                  setNameTouched(true);
                  setName(value);
                }}
              />

              {importMutation.error && (
                <p className="error" role="alert">
                  {t(errorKey(importMutation.error))}
                </p>
              )}

              <button
                type="submit"
                disabled={projectKey === "" || name.trim() === "" || importMutation.isPending}
              >
                {t("jira.import.submit")}
              </button>
            </>
          )}
        </form>
      )}
    </main>
  );
}
