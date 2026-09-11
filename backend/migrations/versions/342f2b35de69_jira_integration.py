"""jira integration

The Jira connection and three link tables for repeated syncs.

jira_connections — one connection per organization (the site address, the email,
the encrypted API token), stored the same way as the LLM key.
jira_project_links — a Planora project created by an import from a Jira project:
the project key, the query (JQL) of the original import and the time of the last
sync. jira_category_links / jira_task_links — the links from plan stages and
tasks to Jira epics and issues: by them a repeated sync learns "this row is
already created" instead of duplicating it on every run.

Revision ID: 342f2b35de69
Revises: b4e7a2c9d3f1
Create Date: 2026-08-20 09:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '342f2b35de69'
down_revision: Union[str, Sequence[str], None] = 'b4e7a2c9d3f1'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        'jira_connections',
        sa.Column('id', sa.UUID(), nullable=False),
        sa.Column('org_id', sa.UUID(), nullable=False),
        sa.Column('base_url', sa.String(length=300), nullable=False),
        sa.Column('email', sa.String(length=320), nullable=False),
        sa.Column('encrypted_token', sa.Text(), nullable=False),
        sa.ForeignKeyConstraint(['org_id'], ['organizations.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('org_id'),
    )

    op.create_table(
        'jira_project_links',
        sa.Column('id', sa.UUID(), nullable=False),
        sa.Column('project_id', sa.UUID(), nullable=False),
        sa.Column('jira_project_key', sa.String(length=64), nullable=False),
        sa.Column('jql', sa.Text(), nullable=False),
        sa.Column('last_synced_at', sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(['project_id'], ['projects.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('project_id'),
    )

    op.create_table(
        'jira_category_links',
        sa.Column('id', sa.UUID(), nullable=False),
        sa.Column('project_id', sa.UUID(), nullable=False),
        sa.Column('category_id', sa.UUID(), nullable=False),
        sa.Column('issue_key', sa.String(length=64), nullable=False),
        sa.ForeignKeyConstraint(['category_id'], ['categories.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['project_id'], ['projects.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('category_id'),
        sa.UniqueConstraint('project_id', 'issue_key'),
    )
    op.create_index(
        op.f('ix_jira_category_links_project_id'), 'jira_category_links', ['project_id'],
        unique=False,
    )

    op.create_table(
        'jira_task_links',
        sa.Column('id', sa.UUID(), nullable=False),
        sa.Column('project_id', sa.UUID(), nullable=False),
        # SET NULL: deleting a task in Planora must not be undone by the next sync
        # — see the JiraTaskLink docstring in app/models.py.
        sa.Column('task_id', sa.UUID(), nullable=True),
        sa.Column('issue_key', sa.String(length=64), nullable=False),
        sa.ForeignKeyConstraint(['project_id'], ['projects.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['task_id'], ['tasks.id'], ondelete='SET NULL'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('project_id', 'issue_key'),
        sa.UniqueConstraint('task_id'),
    )
    op.create_index(
        op.f('ix_jira_task_links_project_id'), 'jira_task_links', ['project_id'],
        unique=False,
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index(op.f('ix_jira_task_links_project_id'), table_name='jira_task_links')
    op.drop_table('jira_task_links')
    op.drop_index(op.f('ix_jira_category_links_project_id'), table_name='jira_category_links')
    op.drop_table('jira_category_links')
    op.drop_table('jira_project_links')
    op.drop_table('jira_connections')
