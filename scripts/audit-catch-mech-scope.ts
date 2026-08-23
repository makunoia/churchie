import { db } from "../lib/db"
import { resolveCatchMechScope } from "../lib/catch-mech/scope"

/**
 * Reports what an event's Catch Mech workspace can still SEE versus what the
 * database still HOLDS.
 *
 * Joining a Collab cluster makes the cluster the breakout owner for every member
 * event (`lib/events/pool-scope.ts`), and `catchMechScopeFor` follows: its Collab
 * branch is `{ clusterId, OR: [...facilitator roles] }` with no `eventId` term at
 * all. Every Catch Mech read — the dashboard, the Pending/Confirmed/Rejected
 * lists, the submissions log — filters on `breakoutGroupId IN <that scope>`, so
 * the event's own standing tables and everything recorded against them drop out
 * of every screen at once. Nothing is deleted; it is out of scope.
 *
 * This script is read-only. It writes nothing and takes no flags.
 *
 *   pnpm dotenv -e .env.local -- tsx scripts/audit-catch-mech-scope.ts <eventId>
 */

async function main() {
  const eventId = process.argv[2]
  if (!eventId) {
    console.error("usage: tsx scripts/audit-catch-mech-scope.ts <eventId>")
    process.exit(1)
  }

  const event = await db.event.findUnique({
    where: { id: eventId },
    select: { id: true, name: true, modules: { select: { type: true } } },
  })
  if (!event) {
    console.error(`No event ${eventId}`)
    process.exit(1)
  }

  const scope = await resolveCatchMechScope(eventId)

  console.log(`Event      : ${event.name} (${event.id})`)
  console.log(`Modules    : ${event.modules.map((m) => m.type).join(", ") || "none"}`)
  console.log(
    `Cluster    : ${scope.clusterName ?? "none"}${scope.viaCluster ? " [Collab — breakouts pooled to the cluster]" : ""}`
  )
  console.log()

  // What the screens can see today.
  const inScope = await db.breakoutGroup.findMany({
    where: scope.where,
    select: { id: true, name: true, eventId: true, clusterId: true },
    orderBy: { name: "asc" },
  })

  // What the event itself owns, regardless of scope.
  const owned = await db.breakoutGroup.findMany({
    where: { eventId },
    select: {
      id: true,
      name: true,
      _count: { select: { members: true, catchMechSessions: true } },
    },
    orderBy: { name: "asc" },
  })

  const inScopeIds = new Set(inScope.map((g) => g.id))
  const hidden = owned.filter((g) => !inScopeIds.has(g.id))

  console.log(`Tables in Catch Mech scope : ${inScope.length}`)
  for (const g of inScope) {
    console.log(`  ${g.clusterId ? "cluster" : "event  "}  ${g.name}  (${g.id})`)
  }
  console.log()
  console.log(`Tables OWNED by this event : ${owned.length}`)
  for (const g of owned) {
    const mark = inScopeIds.has(g.id) ? "visible" : "HIDDEN "
    console.log(
      `  ${mark}  ${g.name}  (${g.id})  members=${g._count.members} sessions=${g._count.catchMechSessions}`
    )
  }
  console.log()

  if (hidden.length === 0) {
    console.log("Nothing of this event's own is out of scope.")
    await db.$disconnect()
    return
  }

  const hiddenIds = hidden.map((g) => g.id)

  // The three record types the Catch Mech screens are built from. All still
  // present — they are simply filtered out by the scope above.
  const [seats, sessions, submissions, requests] = await Promise.all([
    db.breakoutGroupMember.count({ where: { breakoutGroupId: { in: hiddenIds } } }),
    db.catchMechSession.count({ where: { breakoutGroupId: { in: hiddenIds } } }),
    db.confirmationSubmission.count({ where: { breakoutGroupId: { in: hiddenIds } } }),
    db.smallGroupMemberRequest.groupBy({
      by: ["status"],
      where: { breakoutGroupId: { in: hiddenIds } },
      _count: { _all: true },
    }),
  ])

  console.log(`STILL IN THE DATABASE, hidden behind ${hidden.length} out-of-scope table(s):`)
  console.log(`  breakout seats        : ${seats}`)
  console.log(`  catch mech sessions   : ${sessions}`)
  console.log(`  faci submissions      : ${submissions}`)
  for (const r of requests) {
    console.log(`  requests (${r.status.padEnd(9)}) : ${r._count._all}`)
  }

  await db.$disconnect()
}

main().catch(async (e) => {
  console.error(e)
  await db.$disconnect()
  process.exit(1)
})
