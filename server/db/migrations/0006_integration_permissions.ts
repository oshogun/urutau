import type { Kysely } from 'kysely'

/**
 * Adds the `move_cards` permission to `integrations`. It defaults to 1, so every existing integration keeps reading
 * and moving cards as before. It looks the column up first, so it also succeeds when its row in kysely_migration was
 * deleted for a re-run. The names are written out here, not imported, so this migration does not change if the
 * constants do.
 */
export async function up(db: Kysely<any>): Promise<void> {
  const tables = await db.introspection.getTables()
  const integrations = tables.find((t) => t.name === 'integrations')
  if (integrations?.columns.some((c) => c.name === 'move_cards')) return
  await db.schema
    .alterTable('integrations')
    .addColumn('move_cards', 'integer', (c) => c.notNull().defaultTo(1))
    .execute()
}
