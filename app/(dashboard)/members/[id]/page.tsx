import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { db } from "@/lib/db"
import { personTitle } from "@/lib/metadata"
import { auth } from "@/lib/auth"
import { canWrite } from "@/lib/permissions"
import type { FamilyRoleValue } from "@/lib/validations/family"
import { findSpouse } from "@/lib/family-links"
import { MemberForm } from "../member-form"
import { MemberFamilySection, type MemberFamilyEntry } from "./member-family-section"
import { MemberCouplesMatchSection } from "./member-couples-match-section"
import { MemberEventHistory } from "./member-event-history"
import { MemberSmallGroups } from "./member-small-groups"
import { MemberMatchSection } from "./member-match-section"
import { MemberTransferControls } from "./member-transfer-controls"
import { MemberActivityLog, type MemberActivityEntry } from "./member-activity-log"
import { type MemberRow } from "../columns"

function addOneHour(time: string): string {
  const [h, m] = time.split(":").map(Number)
  return `${String((h + 1) % 24).padStart(2, "0")}:${String(m).padStart(2, "0")}`
}

async function getMember(id: string): Promise<MemberRow | null> {
  const m = await db.member.findUnique({
    where: { id },
    include: {
      lifeStage: { select: { id: true, name: true } },
      smallGroup: { select: { name: true } },
      schedulePreferences: {
        select: { dayOfWeek: true, timeStart: true, timeEnd: true },
        orderBy: { createdAt: "asc" },
        take: 1,
      },
    },
  })
  if (!m) return null
  return {
    id: m.id,
    firstName: m.firstName,
    lastName: m.lastName,
    nickname: m.nickname,
    email: m.email,
    phone: m.phone,
    smallGroupName: m.smallGroup?.name ?? null,
    lifeStage: m.lifeStage?.name ?? null,
    dateJoined: m.dateJoined.toISOString().split("T")[0],
    address: m.address,
    notes: m.notes,
    lifeStageId: m.lifeStageId,
    gender: m.gender,
    language: m.language,
    birthMonth: m.birthMonth,
    birthYear: m.birthYear,
    ageRangeBucketId: m.ageRangeBucketId,
    workCity: m.workCity,
    workIndustry: m.workIndustry,
    meetingPreference: m.meetingPreference,
    scheduleDayOfWeek: m.schedulePreferences[0]?.dayOfWeek ?? null,
    scheduleTimeStart: m.schedulePreferences[0]?.timeStart ?? null,
    scheduleTimeEnd: m.schedulePreferences[0]?.timeEnd ?? null,
  }
}

async function getLifeStages() {
  return db.lifeStage.findMany({
    orderBy: { order: "asc" },
    select: { id: true, name: true },
  })
}

async function getAgeRanges() {
  return db.ageRangeBucket.findMany({
    orderBy: { order: "asc" },
    select: { id: true, label: true },
  })
}

async function getMemberSmallGroupInfo(memberId: string) {
  const [m, pendingTransferReq] = await Promise.all([
    db.member.findUnique({
      where: { id: memberId },
      select: {
        smallGroup: { select: { id: true, name: true, groupType: true } },
        groupStatus: true,
        ledGroups: {
          select: {
            id: true,
            name: true,
            groupType: true,
            _count: { select: { members: true } },
          },
          orderBy: { name: "asc" },
        },
      },
    }),
    db.smallGroupMemberRequest.findFirst({
      where: { memberId, status: "Pending" },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        smallGroup: { select: { name: true } },
        createdAt: true,
      },
    }),
  ])
  if (!m) return null
  return {
    memberOf: m.smallGroup
      ? {
          id: m.smallGroup.id,
          name: m.smallGroup.name,
          groupStatus: m.groupStatus ?? null,
          groupType: m.smallGroup.groupType,
        }
      : null,
    ledGroups: m.ledGroups.map(
      (g: { id: string; name: string; groupType: "Regular" | "Couples"; _count: { members: number } }) => ({
        id: g.id,
        name: g.name,
        memberCount: g._count.members,
        groupType: g.groupType,
      }),
    ),
    pendingTransfer: pendingTransferReq?.smallGroup
      ? {
          id: pendingTransferReq.id,
          toGroupName: pendingTransferReq.smallGroup.name,
          createdAt: pendingTransferReq.createdAt,
        }
      : null,
  }
}

async function getMemberFamilies(memberId: string): Promise<MemberFamilyEntry[]> {
  const links = await db.familyMember.findMany({
    where: { memberId },
    orderBy: { createdAt: "asc" },
    select: {
      role: true,
      family: {
        select: {
          id: true,
          name: true,
          members: {
            select: {
              id: true,
              role: true,
              member: { select: { id: true, firstName: true, lastName: true } },
              guest: { select: { firstName: true, lastName: true } },
            },
          },
        },
      },
    },
  })

  return links.map((link) => ({
    familyId: link.family.id,
    familyName: link.family.name,
    role: link.role as FamilyRoleValue,
    others: link.family.members
      .filter((fm) => fm.member?.id !== memberId)
      .map((fm) => {
        const person = fm.member ?? fm.guest
        return {
          name: person ? `${person.firstName} ${person.lastName}` : "Unknown",
          role: fm.role as FamilyRoleValue,
        }
      }),
  }))
}

async function getMemberEventRegistrations(memberId: string) {
  return db.eventRegistrant.findMany({
    where: { memberId },
    orderBy: { createdAt: "desc" },
    include: {
      // MultiDay/Recurring attendance lives here, not on attendedAt.
      _count: { select: { occurrenceAttendances: true } },
      event: {
        include: {
          _count: { select: { occurrences: true } },
          ministries: { include: { ministry: { select: { name: true } } } },
        },
      },
    },
  })
}

async function fetchCatchMechComments(filter: { memberId?: string; guestId?: string }) {
  const comments = await db.catchMechComment.findMany({
    where: { request: filter },
    select: {
      id: true,
      text: true,
      createdAt: true,
      author: { select: { name: true } },
      request: { select: { breakoutGroupId: true } },
    },
    orderBy: { createdAt: "desc" },
  })

  if (comments.length === 0) return []

  const bgIds = [
    ...new Set(
      comments
        .map((c) => c.request.breakoutGroupId)
        .filter((id): id is string => id !== null)
    ),
  ]

  const eventByBgId =
    bgIds.length > 0
      ? await db.catchMechSession
          .findMany({
            where: { breakoutGroupId: { in: bgIds } },
            select: {
              breakoutGroupId: true,
              event: { select: { id: true, name: true } },
            },
          })
          .then((sessions) => new Map(sessions.map((s) => [s.breakoutGroupId, s.event])))
      : new Map<string, { id: string; name: string }>()

  return comments.map((c) => ({
    kind: "catchMechComment" as const,
    id: c.id,
    text: c.text,
    createdAt: c.createdAt,
    author: c.author,
    event:
      (c.request.breakoutGroupId
        ? eventByBgId.get(c.request.breakoutGroupId)
        : null) ?? null,
  }))
}

async function getMemberActivityData(memberId: string) {
  // Find the guest linked to this member (if promoted from guest)
  const guest = await db.guest.findUnique({
    where: { memberId },
    select: { id: true, createdAt: true },
  })

  const [memberLogs, guestLogs, memberRegistrations, guestRegistrations, memberComments, guestComments, memberLogEntries] =
    await Promise.all([
      db.smallGroupLog.findMany({
        where: { memberId },
        orderBy: { createdAt: "desc" },
        include: {
          smallGroup: { select: { id: true, name: true } },
          performedByUser: { select: { name: true } },
          performedByMember: { select: { firstName: true, lastName: true } },
        },
      }),
      guest
        ? db.smallGroupLog.findMany({
            where: { guestId: guest.id },
            orderBy: { createdAt: "desc" },
            include: {
              smallGroup: { select: { id: true, name: true } },
              performedByUser: { select: { name: true } },
          performedByMember: { select: { firstName: true, lastName: true } },
            },
          })
        : Promise.resolve([]),
      db.eventRegistrant.findMany({
        where: { memberId },
        orderBy: { createdAt: "desc" },
        select: { id: true, event: { select: { id: true, name: true } }, createdAt: true },
      }),
      guest
        ? db.eventRegistrant.findMany({
            where: { guestId: guest.id },
            orderBy: { createdAt: "desc" },
            select: { id: true, event: { select: { id: true, name: true } }, createdAt: true },
          })
        : Promise.resolve([]),
      fetchCatchMechComments({ memberId }),
      guest ? fetchCatchMechComments({ guestId: guest.id }) : Promise.resolve([]),
      db.memberLog.findMany({
        where: { memberId },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          action: true,
          description: true,
          createdAt: true,
          event: { select: { id: true, name: true } },
        },
      }),
    ])

  const seenCommentIds = new Set<string>()
  const allComments = [...memberComments, ...guestComments].filter((c) => {
    if (seenCommentIds.has(c.id)) return false
    seenCommentIds.add(c.id)
    return true
  })

  const entries: MemberActivityEntry[] = [
    ...memberLogs.map((log) => ({
      kind: "smallGroupLog" as const,
      id: log.id,
      action: log.action,
      description: log.description,
      smallGroup: log.smallGroup,
      performedByUser: log.performedByUser,
      performedByMember: log.performedByMember,
      createdAt: log.createdAt,
    })),
    ...guestLogs.map((log) => ({
      kind: "smallGroupLog" as const,
      id: `guest-${log.id}`,
      action: log.action,
      description: log.description,
      smallGroup: log.smallGroup,
      performedByUser: log.performedByUser,
      performedByMember: log.performedByMember,
      createdAt: log.createdAt,
    })),
    ...memberRegistrations.map((r) => ({
      kind: "eventRegistration" as const,
      id: r.id,
      event: r.event,
      createdAt: r.createdAt,
    })),
    ...guestRegistrations.map((r) => ({
      kind: "eventRegistration" as const,
      id: `guest-reg-${r.id}`,
      event: r.event,
      createdAt: r.createdAt,
    })),
    ...(guest
      ? [
          {
            kind: "guestOrigin" as const,
            guestId: guest.id,
            createdAt: guest.createdAt,
          },
        ]
      : []),
    ...allComments,
    // `MemberLog.action` decides how the row reads. It used to be selected and then
    // discarded, with `kind` hardcoded — so every entry rendered as "Updated volunteer
    // information" regardless of what it actually recorded.
    ...memberLogEntries.map((log) => ({
      kind: "memberLog" as const,
      id: log.id,
      action: log.action,
      description: log.description,
      event: log.event,
      createdAt: log.createdAt,
    })),
  ].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())

  return entries
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>
}): Promise<Metadata> {
  const { id } = await params
  const member = await db.member.findUnique({
    where: { id },
    select: { firstName: true, lastName: true },
  })
  return { title: { absolute: personTitle(member, "Members") } }
}

export default async function MemberDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const [session, member, lifeStages, ageRanges, registrations, smallGroupInfo, activityEntries, allSmallGroups, families, spouse] = await Promise.all([
    auth(),
    getMember(id),
    getLifeStages(),
    getAgeRanges(),
    getMemberEventRegistrations(id),
    getMemberSmallGroupInfo(id),
    getMemberActivityData(id),
    db.smallGroup.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
    getMemberFamilies(id),
    findSpouse(id),
  ])

  if (!member) notFound()

  return (
    <MemberForm
      member={member}
      ageRanges={ageRanges}
      groupStatus={smallGroupInfo?.memberOf?.groupStatus ?? null}
      eventHistory={<MemberEventHistory registrations={registrations} />}
      activityHistory={<MemberActivityLog entries={activityEntries} />}
      family={
        <MemberFamilySection
          families={families}
          canWrite={canWrite(session, "Members")}
        />
      }
      smallGroups={
        smallGroupInfo ? (
          <div className="space-y-6">
            <MemberSmallGroups
              memberOf={smallGroupInfo.memberOf}
              ledGroups={smallGroupInfo.ledGroups}
            />
            <div className="border-t" />
            {smallGroupInfo.memberOf ? (
              <MemberTransferControls
                memberId={id}
                currentGroupId={smallGroupInfo.memberOf.id}
                pendingTransfer={smallGroupInfo.pendingTransfer}
                initialPrefs={{
                  lifeStageId: member.lifeStageId ?? "",
                  gender: member.gender ?? "",
                  language: member.language,
                  workCity: member.workCity ?? "",
                  workIndustry: member.workIndustry ?? "",
                  meetingPreference: member.meetingPreference ?? "",
                  scheduleDayOfWeek:
                    member.scheduleDayOfWeek != null ? String(member.scheduleDayOfWeek) : "",
                  scheduleTimeStart: member.scheduleTimeStart ?? "",
                  scheduleTimeEnd: member.scheduleTimeEnd ?? (member.scheduleTimeStart ? addOneHour(member.scheduleTimeStart) : ""),
                }}
                lifeStages={lifeStages}
                allGroups={allSmallGroups}
              />
            ) : (
              <MemberMatchSection
                memberId={id}
                hasGroup={false}
                pendingTransfer={null}
                initialPrefs={{
                  lifeStageId: member.lifeStageId ?? "",
                  gender: member.gender ?? "",
                  language: member.language,
                  workCity: member.workCity ?? "",
                  workIndustry: member.workIndustry ?? "",
                  meetingPreference: member.meetingPreference ?? "",
                  scheduleDayOfWeek:
                    member.scheduleDayOfWeek != null ? String(member.scheduleDayOfWeek) : "",
                  scheduleTimeStart: member.scheduleTimeStart ?? "",
                  scheduleTimeEnd: member.scheduleTimeEnd ?? (member.scheduleTimeStart ? addOneHour(member.scheduleTimeStart) : ""),
                }}
                lifeStages={lifeStages}
              />
            )}
            {spouse && (
              <>
                <div className="border-t" />
                <MemberCouplesMatchSection
                  memberId={id}
                  memberFirstName={member.nickname || member.firstName}
                  spouse={{
                    memberId: spouse.memberId,
                    firstName: spouse.firstName,
                    lastName: spouse.lastName,
                  }}
                />
              </>
            )}
          </div>
        ) : undefined
      }
    />
  )
}
