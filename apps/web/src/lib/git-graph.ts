/** Stable lanes: reuse free slots without shifting neighboring branches. */
export interface GraphCommit {
  hash: string
  parents: string[]
}
interface Lane {
  hash: string
  color: number
}
export interface GraphEdge {
  from: number
  to: number
  color: number
}
export interface GraphRow {
  lane: number
  color: number
  incoming: GraphEdge[]
  outgoing: GraphEdge[]
}

export function layoutGitGraph(commits: GraphCommit[]): { rows: GraphRow[]; width: number } {
  const lanes: (Lane | null)[] = []
  let nextColor = 0
  let width = 1
  const allocate = (value: Lane) => {
    const free = lanes.indexOf(null)
    const index = free < 0 ? lanes.length : free
    lanes[index] = value
    return index
  }
  const rows = commits.map((commit) => {
    const incoming: GraphEdge[] = []
    lanes.forEach((lane, index) => {
      if (lane) incoming.push({ from: index, to: index, color: lane.color })
    })
    let lane = lanes.findIndex((entry) => entry?.hash === commit.hash)
    if (lane < 0) lane = allocate({ hash: commit.hash, color: nextColor++ })
    const color = lanes[lane]!.color
    lanes[lane] = null
    const outgoing: GraphEdge[] = []
    lanes.forEach((entry, index) => {
      if (entry) outgoing.push({ from: index, to: index, color: entry.color })
    })
    commit.parents.forEach((hash, index) => {
      let target = lanes.findIndex((entry) => entry?.hash === hash)
      if (target < 0) {
        const entry = { hash, color: index === 0 ? color : nextColor++ }
        if (index === 0 && lanes[lane] === null) {
          lanes[lane] = entry
          target = lane
        } else target = allocate(entry)
      }
      outgoing.push({ from: lane, to: target, color: lanes[target]!.color })
    })
    width = Math.max(width, lanes.length, lane + 1)
    return { lane, color, incoming, outgoing }
  })
  return { rows, width }
}

// The palette remains readable in both themes; geometry also conveys links.
export const GRAPH_COLORS = ['#4385d5', '#b26bca', '#2c9b88', '#d18b32', '#d96683', '#778bd0', '#839b32']
export const graphColor = (color: number) => `var(--git-rail-${color % GRAPH_COLORS.length}, ${GRAPH_COLORS[color % GRAPH_COLORS.length]!})`
