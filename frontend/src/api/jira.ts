import { request } from "./client";

export const JIRA_CREDENTIAL_QUERY_KEY = ["jira", "credential"] as const;
export const JIRA_PROJECTS_QUERY_KEY = ["jira", "projects"] as const;

/** The project's key, set from the project's own address in its card. */
export function jiraLinkQueryKey(projectId: string) {
  return ["jira", "link", projectId] as const;
}

/** The Jira connection. There is and can be no token here — only a flag. */
export type JiraCredential = {
  base_url: string;
  email: string;
  configured: boolean;
};

export type JiraProject = {
  key: string;
  name: string;
};

export type JiraImportResult = {
  project_id: string;
  batch_id: string;
  created_categories: number;
  created_tasks: number;
};

export type JiraSyncResult = {
  batch_id: string;
  created_categories: number;
  created_tasks: number;
  updated_tasks: number;
};

/** Whether the project was created by an import from Jira, and when it last synced. */
export type JiraLink = {
  linked: boolean;
  jira_project_key: string | null;
  jql: string | null;
  last_synced_at: string | null;
};

export type JiraPushFailure = {
  issue_key: string;
  code: string;
};

export type JiraPushResult = {
  pushed: number;
  unchanged: number;
  failed: JiraPushFailure[];
};

export function readJiraCredential(): Promise<JiraCredential> {
  return request<JiraCredential>("/api/jira/credential");
}

export function saveJiraCredential(payload: {
  base_url: string;
  email: string;
  api_token: string;
}): Promise<JiraCredential> {
  return request<JiraCredential>("/api/jira/credential", {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

export function disconnectJira(): Promise<void> {
  return request<void>("/api/jira/credential", { method: "DELETE" });
}

export function listJiraProjects(): Promise<JiraProject[]> {
  return request<JiraProject[]>("/api/jira/projects");
}

export function importFromJira(payload: {
  jira_project_key: string;
  name: string;
}): Promise<JiraImportResult> {
  return request<JiraImportResult>("/api/jira/import", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function readJiraLink(projectId: string): Promise<JiraLink> {
  return request<JiraLink>(`/api/projects/${projectId}/jira`);
}

export function syncFromJira(projectId: string): Promise<JiraSyncResult> {
  return request<JiraSyncResult>(`/api/projects/${projectId}/jira/sync`, { method: "POST" });
}

export function pushToJira(projectId: string): Promise<JiraPushResult> {
  return request<JiraPushResult>(`/api/projects/${projectId}/jira/push`, { method: "POST" });
}
