import { User } from '@carbon/icons-react'
import { OverflowMenu, OverflowMenuItem } from '@carbon/react'
import { useSession } from '../../state/session'

interface UserMenuProps {
  onOpenUsers: () => void
  onSignOut: () => Promise<void>
}

/** Header menu for the signed-in user: who they are, the admin's users screen, and sign out. */
export function UserMenu({ onOpenUsers, onSignOut }: UserMenuProps) {
  const user = useSession((state) => state.session?.user)
  if (!user) return null

  return (
    <OverflowMenu
      className="user-menu"
      menuOptionsClass="user-menu__options"
      aria-label={`Account menu for ${user.username}`}
      iconDescription={`Account menu for ${user.username}`}
      renderIcon={User}
      size="lg"
      flipped
    >
      <OverflowMenuItem itemText={`Signed in as ${user.username}`} disabled />
      {user.isAdmin && <OverflowMenuItem itemText="Users" hasDivider onClick={onOpenUsers} />}
      <OverflowMenuItem
        itemText="Sign out"
        hasDivider
        onClick={() => void onSignOut()}
      />
    </OverflowMenu>
  )
}
