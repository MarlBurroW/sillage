import type { BackgroundWork } from './background'
import type { SubAgent } from './subagents'

/**
 * Who launched what, for the Agents pane: a shell or sub-agent started by a sub-agent sits under
 * it. Sub-agents nest by spawning call (`parentId`), background work by the CLI's `parentTaskId`.
 * A parent the pane does not know (main thread, ended and forgotten, older CLI) leaves the node at
 * the root, as the Claude SDK asks.
 */
export type AgentNode = SubAgentNode | BackgroundNode
type SubAgentNode = { kind: 'agent'; agent: SubAgent; children: AgentNode[] }
type BackgroundNode = { kind: 'background'; work: BackgroundWork; children: AgentNode[] }

export interface AgentTree {
  /** Background work launched by the main thread, with what it launched in turn. */
  background: AgentNode[]
  /** Sub-agents launched by the main thread, in launch order. */
  agents: AgentNode[]
}

export function buildAgentTree(agents: SubAgent[], background: BackgroundWork[]): AgentTree {
  const agentNodes = new Map<string, SubAgentNode>()
  const byTask = new Map<string, AgentNode>()
  for (const agent of agents) {
    const node: SubAgentNode = { kind: 'agent', agent, children: [] }
    agentNodes.set(agent.id, node)
    if (agent.taskId) byTask.set(agent.taskId, node)
  }
  const workNodes = background.map((work): BackgroundNode => ({ kind: 'background', work, children: [] }))
  for (const node of workNodes) if (!byTask.has(node.work.id)) byTask.set(node.work.id, node)

  const parents = new Map<AgentNode, AgentNode>()
  // Spawning calls form a tree by construction; task ids come from the CLI, so refuse a parent
  // that would close a loop rather than lose both nodes.
  const attach = (node: AgentNode, parent: AgentNode | undefined): boolean => {
    for (let up = parent; up; up = parents.get(up)) if (up === node) return false
    if (!parent) return false
    parents.set(node, parent)
    return true
  }

  const tree: AgentTree = { background: [], agents: [] }
  // Background children first, like the pane's root, where live work sits above the sub-agents.
  for (const node of workNodes) {
    const parent = node.work.parentTaskId ? byTask.get(node.work.parentTaskId) : undefined
    if (attach(node, parent)) parent!.children.push(node)
    else tree.background.push(node)
  }
  for (const node of agentNodes.values()) {
    const parent = node.agent.parentId ? agentNodes.get(node.agent.parentId) : undefined
    if (attach(node, parent)) parent!.children.push(node)
    else tree.agents.push(node)
  }
  return tree
}
