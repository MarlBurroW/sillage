import { graphColor, type GraphRow } from '../../../lib/git-graph'

export function GraphRail({ row, width, head }: { row: GraphRow; width: number; head: boolean }) {
  const x = (lane: number) => 20 + lane * 18
  return (
    <svg aria-hidden="true" width={width * 18 + 22} height={56} className="shrink-0" data-git-rail>
      {row.incoming.map((edge, index) => (
        <path
          key={`in-${index}`}
          d={`M ${x(edge.from)} 0 L ${x(edge.to)} 28`}
          fill="none"
          stroke={graphColor(edge.color)}
          strokeWidth="2"
        />
      ))}
      {row.outgoing.map((edge, index) => (
        <path
          key={`out-${index}`}
          d={`M ${x(edge.from)} 28 C ${x(edge.from)} 43 ${x(edge.to)} 43 ${x(edge.to)} 56`}
          fill="none"
          stroke={graphColor(edge.color)}
          strokeWidth="2"
        />
      ))}
      {head ? (
        <circle cx={x(row.lane)} cy="28" r="9" fill="none" stroke={graphColor(row.color)} strokeWidth="1.5" />
      ) : null}
      <circle
        cx={x(row.lane)}
        cy="28"
        r="4"
        fill="var(--sg-surface, #20242c)"
        stroke={graphColor(row.color)}
        strokeWidth="2"
      />
    </svg>
  )
}
