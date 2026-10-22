import type { AutomationTemplateId } from '@sillage/protocol'
import type { MessageKey } from './i18n'

/**
 * Sample calls for an automation page's sandbox, allowing settings tests without GitHub or curl.
 * Use real call shapes reduced to useful template and filter fields (`action`, `label`, `sender`,
 * etc.). Contents remain English, like most forge data, regardless of UI language. Loaded only by
 * this page's own chunk, never the main bundle.
 */

export interface AutomationSample {
  id: string
  label: MessageKey
  /** Templates for which this example is relevant, offered first. */
  templates: AutomationTemplateId[]
  headers: Record<string, string>
  payload: unknown
}

const repository = {
  id: 1296269,
  name: 'nimbus',
  full_name: 'demo/nimbus',
  html_url: 'https://github.com/demo/nimbus',
  default_branch: 'main',
}
const sender = { login: 'alex', id: 583231, type: 'User' }
const issue = {
  number: 42,
  title: 'Crash on startup when the cache is empty',
  body: 'The server crashes on first launch when `~/.cache/nimbus` does not exist.',
  html_url: 'https://github.com/demo/nimbus/issues/42',
  state: 'open',
  user: sender,
  labels: [{ name: 'bug' }],
}

/** Delivery identifier like GitHub includes with every delivery. */
function deliveryId(): string {
  // `crypto.randomUUID` exists only in secure contexts; tailnet demos use HTTP.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const value = Math.floor(Math.random() * 16)
    return (char === 'x' ? value : (value & 0x3) | 0x8).toString(16)
  })
}

function github(event: string, payload: unknown): { headers: Record<string, string>; payload: unknown } {
  return {
    headers: { 'x-github-event': event, 'x-github-delivery': deliveryId(), 'user-agent': 'GitHub-Hookshot/sample' },
    payload,
  }
}

/** Examples with a fresh delivery ID for each call. */
export function automationSamples(): AutomationSample[] {
  return [
    {
      id: 'github_ping',
      label: 'automation.sample.githubPing',
      templates: ['github_issue_label', 'github_comment_command', 'github_pr_opened', 'github_ci_failed'],
      ...github('ping', { zen: 'Design for failure.', hook_id: 1, hook: { type: 'Repository', events: ['issues'] }, repository, sender }),
    },
    {
      id: 'github_issue_labeled_sillage',
      label: 'automation.sample.githubLabeledSillage',
      templates: ['github_issue_label'],
      ...github('issues', {
        action: 'labeled',
        label: { name: 'sillage' },
        issue: { ...issue, labels: [{ name: 'bug' }, { name: 'sillage' }] },
        repository,
        sender,
      }),
    },
    {
      id: 'github_issue_labeled_other',
      label: 'automation.sample.githubLabeledOther',
      templates: ['github_issue_label'],
      ...github('issues', { action: 'labeled', label: { name: 'bug' }, issue, repository, sender }),
    },
    {
      id: 'github_issue_opened',
      label: 'automation.sample.githubIssueOpened',
      templates: ['github_issue_label'],
      ...github('issues', { action: 'opened', issue, repository, sender }),
    },
    {
      id: 'github_comment_command',
      label: 'automation.sample.githubComment',
      templates: ['github_comment_command'],
      ...github('issue_comment', {
        action: 'created',
        issue,
        comment: {
          id: 1001,
          body: '/sillage add a test that reproduces the crash, then fix it',
          user: sender,
          html_url: 'https://github.com/demo/nimbus/issues/42#issuecomment-1001',
        },
        repository,
        sender,
      }),
    },
    {
      id: 'github_pr_opened',
      label: 'automation.sample.githubPr',
      templates: ['github_pr_opened'],
      ...github('pull_request', {
        action: 'opened',
        number: 57,
        pull_request: {
          number: 57,
          title: 'Create the cache directory on startup',
          body: 'Fixes #42.',
          draft: false,
          html_url: 'https://github.com/demo/nimbus/pull/57',
          head: { ref: 'fix/cache-dir' },
          base: { ref: 'main' },
          user: sender,
        },
        repository,
        sender,
      }),
    },
    {
      id: 'github_ci_failed',
      label: 'automation.sample.githubCi',
      templates: ['github_ci_failed'],
      ...github('workflow_run', {
        action: 'completed',
        workflow_run: {
          id: 30433642,
          name: 'CI',
          head_branch: 'main',
          head_sha: '9fceb02d0ae598e95dc970b74767f19372d61af8',
          conclusion: 'failure',
          html_url: 'https://github.com/demo/nimbus/actions/runs/30433642',
          head_commit: { message: 'Update dependencies' },
        },
        repository,
        sender,
      }),
    },
    {
      id: 'gitlab_issue',
      label: 'automation.sample.gitlabIssue',
      templates: ['gitlab_generic'],
      headers: { 'x-gitlab-event': 'Issue Hook', 'x-gitlab-event-uuid': deliveryId() },
      payload: {
        object_kind: 'issue',
        event_type: 'issue',
        user: { username: 'alex' },
        project: { path_with_namespace: 'demo/nimbus', web_url: 'https://gitlab.com/demo/nimbus' },
        object_attributes: { iid: 12, title: 'The cache never empties', action: 'open', url: 'https://gitlab.com/demo/nimbus/-/issues/12' },
      },
    },
  ]
}
