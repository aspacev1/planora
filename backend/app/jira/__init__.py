"""The Jira integration: connecting, importing a project, re-syncing.

Data flows one way — from Jira into Planora. Writing back (carrying Planora
statuses into Jira) is not part of the MVP: a Jira plan is already maintained
in Jira itself, and Planora reads it here to build the Gantt chart and the
scorecard, which Jira does not have out of the box.

An import creates a new project as a batch of ordinary mutations sharing a
`batch_id` — the same technique as applying an AI draft (see app.ai.intake):
the history of tasks created from Jira is no different from the history of any
others, and the whole batch can be undone with one button. A sync updates the
rows already created and appends new ones the same way.

Modules:
  errors.py      — JiraError, shared by the client and the sync layer.
  netguard.py    — validating the Jira site address before a request (SSRF).
  client.py      — HTTP over the Jira Cloud REST API v3, plus a protocol for tests.
  credentials.py — storing the connection (encrypted token) and building a client.
  mapping.py     — pure functions: a Jira field -> a Planora task field.
  sync.py        — import and sync: assembling mutations from Jira's answer.
"""
