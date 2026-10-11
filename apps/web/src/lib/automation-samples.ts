import type { AutomationTemplateId } from '@sillage/protocol'
import type { MessageKey } from './i18n'

/**
 * Des appels d'exemple pour le bac à sable de la page d'une automatisation : de quoi
 * essayer ses réglages sans GitHub ni curl.
 *
 * Au format des vrais appels, réduits à ce qui sert : les champs que lisent les modèles
 * et ceux qu'on a envie de filtrer (`action`, `label`, `sender`…). Leur contenu est en
 * anglais, comme le gros de ce qu'on trouve sur une forge, quelle que soit la langue de
 * l'interface. Chargés seulement par
 * la page, qui vit dans son propre morceau : ils n'ont rien à faire dans le paquet
 * principal.
 */

export interface AutomationSample {
  id: string
  label: MessageKey
  /** Les modèles pour lesquels cet exemple est pertinent ; proposés en premier. */
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

/** Un identifiant de livraison, comme GitHub en met un à chaque envoi. */
function deliveryId(): string {
  // `crypto.randomUUID` n'existe qu'en contexte sécurisé, et une démo sur le tailnet
  // est servie en http.
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

/** Les exemples, avec un identifiant de livraison neuf à chaque appel. */
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
