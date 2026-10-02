import { Tag } from '@carbon/react'
import type { CSSProperties } from 'react'
import { tagTypeForColor } from '../domain/labels'
import type { Label } from '../domain/types'

interface LabelTagProps {
  label: Label
  size?: 'sm' | 'md'
}

/**
 * A GitHub label as a Carbon tag: the tag uses the closest Carbon palette so it
 * reads well in both themes, and a dot shows the label's exact GitHub color.
 */
export function LabelTag({ label, size = 'sm' }: LabelTagProps) {
  const style = { '--label-color': `#${label.color}` } as CSSProperties
  return (
    <Tag size={size} type={tagTypeForColor(label.color)} className="label-tag" style={style}>
      {label.name}
    </Tag>
  )
}
