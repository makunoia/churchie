-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Gender" AS ENUM ('Male', 'Female');

-- CreateEnum
CREATE TYPE "MeetingPreference" AS ENUM ('Online', 'Hybrid', 'InPerson');

-- CreateEnum
CREATE TYPE "GenderFocus" AS ENUM ('Male', 'Female', 'Mixed');

-- CreateEnum
CREATE TYPE "MeetingFormat" AS ENUM ('Online', 'Hybrid', 'InPerson');

-- CreateEnum
CREATE TYPE "VolunteerStatus" AS ENUM ('Pending', 'Confirmed', 'Rejected');

-- CreateEnum
CREATE TYPE "MatchingContext" AS ENUM ('SmallGroup', 'Breakout');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "name" TEXT,
    "email" TEXT NOT NULL,
    "emailVerified" TIMESTAMP(3),
    "image" TEXT,
    "password" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Account" (
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerAccountId" TEXT NOT NULL,
    "refresh_token" TEXT,
    "access_token" TEXT,
    "expires_at" INTEGER,
    "token_type" TEXT,
    "scope" TEXT,
    "id_token" TEXT,
    "session_state" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("provider","providerAccountId")
);

-- CreateTable
CREATE TABLE "Session" (
    "sessionToken" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL
);

-- CreateTable
CREATE TABLE "VerificationToken" (
    "identifier" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VerificationToken_pkey" PRIMARY KEY ("identifier","token")
);

-- CreateTable
CREATE TABLE "LifeStage" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LifeStage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Member" (
    "id" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "address" TEXT,
    "dateJoined" TIMESTAMP(3) NOT NULL,
    "notes" TEXT,
    "lifeStageId" TEXT,
    "smallGroupId" TEXT,
    "gender" "Gender",
    "language" TEXT,
    "birthDate" TIMESTAMP(3),
    "workCity" TEXT,
    "workIndustry" TEXT,
    "meetingPreference" "MeetingPreference",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Member_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SchedulePreference" (
    "id" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "dayOfWeek" INTEGER NOT NULL,
    "timeStart" TEXT NOT NULL,
    "timeEnd" TEXT NOT NULL,

    CONSTRAINT "SchedulePreference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SmallGroup" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "leaderId" TEXT NOT NULL,
    "parentGroupId" TEXT,
    "lifeStageId" TEXT,
    "genderFocus" "GenderFocus",
    "language" TEXT,
    "ageRangeMin" INTEGER,
    "ageRangeMax" INTEGER,
    "meetingFormat" "MeetingFormat",
    "locationCity" TEXT,
    "memberLimit" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SmallGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GroupMeetingSchedule" (
    "id" TEXT NOT NULL,
    "smallGroupId" TEXT NOT NULL,
    "dayOfWeek" INTEGER NOT NULL,
    "timeStart" TEXT NOT NULL,
    "timeEnd" TEXT NOT NULL,

    CONSTRAINT "GroupMeetingSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Ministry" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "lifeStageId" TEXT,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Ministry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Event" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "ministryId" TEXT NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "isPaid" BOOLEAN NOT NULL DEFAULT false,
    "price" INTEGER,
    "registrationStart" TIMESTAMP(3),
    "registrationEnd" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventRegistrant" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "memberId" TEXT,
    "firstName" TEXT,
    "lastName" TEXT,
    "nickname" TEXT,
    "email" TEXT,
    "mobileNumber" TEXT,
    "isPaid" BOOLEAN NOT NULL DEFAULT false,
    "attendedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EventRegistrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BreakoutGroup" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "facilitatorId" TEXT,
    "memberLimit" INTEGER,
    "lifeStage" TEXT,
    "genderFocus" "GenderFocus",
    "language" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BreakoutGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BreakoutGroupMember" (
    "breakoutGroupId" TEXT NOT NULL,
    "registrantId" TEXT NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BreakoutGroupMember_pkey" PRIMARY KEY ("breakoutGroupId","registrantId")
);

-- CreateTable
CREATE TABLE "VolunteerCommittee" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ministryId" TEXT,
    "eventId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VolunteerCommittee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommitteeRole" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "committeeId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommitteeRole_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Volunteer" (
    "id" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "ministryId" TEXT,
    "eventId" TEXT,
    "committeeId" TEXT NOT NULL,
    "preferredRoleId" TEXT NOT NULL,
    "assignedRoleId" TEXT,
    "status" "VolunteerStatus" NOT NULL DEFAULT 'Pending',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Volunteer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MatchingWeightConfig" (
    "id" TEXT NOT NULL,
    "context" "MatchingContext" NOT NULL,
    "lifeStage" DOUBLE PRECISION NOT NULL,
    "gender" DOUBLE PRECISION NOT NULL,
    "language" DOUBLE PRECISION NOT NULL,
    "age" DOUBLE PRECISION NOT NULL,
    "schedule" DOUBLE PRECISION NOT NULL,
    "location" DOUBLE PRECISION NOT NULL,
    "mode" DOUBLE PRECISION NOT NULL,
    "career" DOUBLE PRECISION NOT NULL,
    "capacity" DOUBLE PRECISION NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MatchingWeightConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Session_sessionToken_key" ON "Session"("sessionToken");

-- CreateIndex
CREATE UNIQUE INDEX "LifeStage_name_key" ON "LifeStage"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Member_email_key" ON "Member"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Ministry_name_key" ON "Ministry"("name");

-- CreateIndex
CREATE UNIQUE INDEX "MatchingWeightConfig_context_key" ON "MatchingWeightConfig"("context");

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Member" ADD CONSTRAINT "Member_lifeStageId_fkey" FOREIGN KEY ("lifeStageId") REFERENCES "LifeStage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Member" ADD CONSTRAINT "Member_smallGroupId_fkey" FOREIGN KEY ("smallGroupId") REFERENCES "SmallGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SchedulePreference" ADD CONSTRAINT "SchedulePreference_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SmallGroup" ADD CONSTRAINT "SmallGroup_leaderId_fkey" FOREIGN KEY ("leaderId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SmallGroup" ADD CONSTRAINT "SmallGroup_parentGroupId_fkey" FOREIGN KEY ("parentGroupId") REFERENCES "SmallGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SmallGroup" ADD CONSTRAINT "SmallGroup_lifeStageId_fkey" FOREIGN KEY ("lifeStageId") REFERENCES "LifeStage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupMeetingSchedule" ADD CONSTRAINT "GroupMeetingSchedule_smallGroupId_fkey" FOREIGN KEY ("smallGroupId") REFERENCES "SmallGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ministry" ADD CONSTRAINT "Ministry_lifeStageId_fkey" FOREIGN KEY ("lifeStageId") REFERENCES "LifeStage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_ministryId_fkey" FOREIGN KEY ("ministryId") REFERENCES "Ministry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventRegistrant" ADD CONSTRAINT "EventRegistrant_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventRegistrant" ADD CONSTRAINT "EventRegistrant_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BreakoutGroup" ADD CONSTRAINT "BreakoutGroup_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BreakoutGroup" ADD CONSTRAINT "BreakoutGroup_facilitatorId_fkey" FOREIGN KEY ("facilitatorId") REFERENCES "Volunteer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BreakoutGroupMember" ADD CONSTRAINT "BreakoutGroupMember_breakoutGroupId_fkey" FOREIGN KEY ("breakoutGroupId") REFERENCES "BreakoutGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BreakoutGroupMember" ADD CONSTRAINT "BreakoutGroupMember_registrantId_fkey" FOREIGN KEY ("registrantId") REFERENCES "EventRegistrant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VolunteerCommittee" ADD CONSTRAINT "VolunteerCommittee_ministryId_fkey" FOREIGN KEY ("ministryId") REFERENCES "Ministry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VolunteerCommittee" ADD CONSTRAINT "VolunteerCommittee_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommitteeRole" ADD CONSTRAINT "CommitteeRole_committeeId_fkey" FOREIGN KEY ("committeeId") REFERENCES "VolunteerCommittee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Volunteer" ADD CONSTRAINT "Volunteer_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Volunteer" ADD CONSTRAINT "Volunteer_ministryId_fkey" FOREIGN KEY ("ministryId") REFERENCES "Ministry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Volunteer" ADD CONSTRAINT "Volunteer_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Volunteer" ADD CONSTRAINT "Volunteer_committeeId_fkey" FOREIGN KEY ("committeeId") REFERENCES "VolunteerCommittee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Volunteer" ADD CONSTRAINT "Volunteer_preferredRoleId_fkey" FOREIGN KEY ("preferredRoleId") REFERENCES "CommitteeRole"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Volunteer" ADD CONSTRAINT "Volunteer_assignedRoleId_fkey" FOREIGN KEY ("assignedRoleId") REFERENCES "CommitteeRole"("id") ON DELETE SET NULL ON UPDATE CASCADE;
