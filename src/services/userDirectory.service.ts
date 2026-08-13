import { prisma } from "../utils/prisma";
import { getAcademicClient } from "./tenantDb.service";
import { resolveUsers } from "./userLookup.service";

export type DirectoryRole = "ADMIN" | "SUB_ADMIN" | "TEACHER" | "STUDENT";

export interface DirectoryUser {
  id: string;
  name: string;
  role: DirectoryRole;
  email: string;
  phone: string | null;
  userId: string;
  class: string | null;
  addedBy: string | null;
  joinedAt: string; // ISO date
  status: "ACTIVE" | "INACTIVE";
}

interface StatusEventRow { userId: string; isActive: boolean; createdAt: Date }

// Reconstructs whether a user was active on at least one moment during
// [monthStart, monthEnd], from their ordered isActive-transition history.
// This is the loophole-proofing rule: activating at the start of the month
// and deactivating right before it ends still counts as active for that
// whole month, because billing is meant to reflect real usage, not a
// snapshot an admin can dodge by timing a toggle around it.
function wasActiveDuringMonth(
  events: StatusEventRow[],
  monthStart: Date,
  monthEnd: Date
): boolean {
  if (events.length === 0) return false;
  const beforeOrAtStart = events.filter((e) => e.createdAt <= monthStart);
  const withinMonth = events.filter((e) => e.createdAt > monthStart && e.createdAt <= monthEnd);

  let stateAtStart: boolean;
  if (beforeOrAtStart.length > 0) {
    stateAtStart = beforeOrAtStart[beforeOrAtStart.length - 1].isActive;
  } else {
    // No event at/before month start — the user's history begins mid-month
    // (they joined during this month). Their very first recorded state is
    // effectively their state from the moment they came into existence.
    stateAtStart = events[0].isActive;
  }

  if (stateAtStart) return true;
  return withinMonth.some((e) => e.isActive === true);
}

/** Returns every ADMIN/SUB_ADMIN/TEACHER/STUDENT in the institution who
 * existed by the end of the given month, with their reconstructed
 * active/inactive status for that specific month (not just "right now"). */
export async function getInstitutionUsersForMonth(
  institutionId: string,
  year: number,
  month: number // 1-12
): Promise<DirectoryUser[]> {
  const monthStart = new Date(year, month - 1, 1, 0, 0, 0, 0);
  const monthEnd = new Date(year, month, 0, 23, 59, 59, 999);

  // Teacher/Student are academic — for BYOD they live in the institution's own DB.
  const acad = await getAcademicClient(institutionId);

  const [institution, admins, subAdmins, teachers, students, statusEvents, addedByLogs] = await Promise.all([
    prisma.institution.findUnique({ where: { id: institutionId }, select: { adminPhone: true } }),
    prisma.user.findMany({
      where: { institutionId, role: "ADMIN" },
      select: { id: true, name: true, email: true, displayId: true, createdAt: true, isActive: true },
    }),
    prisma.subAdmin.findMany({
      where: { institutionId },
      select: {
        userId: true, phone: true, createdById: true,
        user: { select: { id: true, name: true, email: true, displayId: true, createdAt: true, isActive: true } },
      },
    }),
    acad.teacher.findMany({
      where: { institutionId },
      select: { userId: true, teacherId: true, phone: true, joinedAt: true },
    }),
    acad.student.findMany({
      where: { institutionId },
      select: {
        userId: true, studentId: true, phone: true,
        standard: { select: { name: true } },
        division: { select: { name: true } },
      },
    }),
    prisma.userStatusEvent.findMany({
      where: { institutionId, createdAt: { lte: monthEnd } },
      orderBy: { createdAt: "asc" },
      select: { userId: true, isActive: true, createdAt: true },
    }),
    // "Added by" is reconstructed on a best-effort basis from the ADDED audit
    // trail, matched by the new user's email (the one field every ADDED
    // event's metadata consistently includes, unlike the target's own id
    // which is stored inconsistently — business code in some call sites, PK
    // in others).
    prisma.auditLog.findMany({
      where: { institutionId, action: { in: ["STUDENT_ADDED", "TEACHER_ADDED", "SUBADMIN_ADDED"] } },
      select: { userId: true, metadata: true },
    }),
  ]);

  // Teacher/Student rows may live in a tenant DB (BYOD) with no User table, so
  // the linked User (name/email/createdAt/isActive) is fetched from central.
  const personUsers = await resolveUsers(
    [...teachers.map((t) => t.userId), ...students.map((s) => s.userId)],
    { id: true, name: true, email: true, createdAt: true, isActive: true }
  );

  const eventsByUser = new Map<string, StatusEventRow[]>();
  for (const e of statusEvents) {
    const list = eventsByUser.get(e.userId) ?? [];
    list.push(e);
    eventsByUser.set(e.userId, list);
  }

  // actorUserId -> name, so "added by" can resolve to a display name
  const actorIds = Array.from(new Set(addedByLogs.map((l) => l.userId).filter((id): id is string => !!id)));
  const actors = actorIds.length > 0
    ? await prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true } })
    : [];
  const actorNameById = new Map(actors.map((a) => [a.id, a.name ?? "—"]));

  const addedByEmail = new Map<string, string>();
  for (const log of addedByLogs) {
    const meta = log.metadata as Record<string, unknown> | null;
    const email = meta && typeof meta.email === "string" ? meta.email : null;
    if (email && log.userId && actorNameById.has(log.userId)) {
      addedByEmail.set(email, actorNameById.get(log.userId)!);
    }
  }

  const results: DirectoryUser[] = [];

  const pushIfExisted = (opts: {
    userId: string; name: string | null; email: string; createdAt: Date; isActive: boolean;
    role: DirectoryRole; businessId: string; phone: string | null; classLabel: string | null; addedBy: string | null;
  }) => {
    if (opts.createdAt > monthEnd) return; // didn't exist yet this month
    const events = eventsByUser.get(opts.userId) ?? [];
    const status: "ACTIVE" | "INACTIVE" = events.length > 0
      ? (wasActiveDuringMonth(events, monthStart, monthEnd) ? "ACTIVE" : "INACTIVE")
      : (opts.isActive ? "ACTIVE" : "INACTIVE"); // legacy fallback: no tracked history, use current state
    results.push({
      id: opts.userId,
      name: opts.name ?? "—",
      role: opts.role,
      email: opts.email,
      phone: opts.phone,
      userId: opts.businessId,
      class: opts.classLabel,
      addedBy: opts.addedBy,
      joinedAt: opts.createdAt.toISOString(),
      status,
    });
  };

  for (const a of admins) {
    pushIfExisted({
      userId: a.id, name: a.name, email: a.email, createdAt: a.createdAt, isActive: a.isActive,
      role: "ADMIN", businessId: a.displayId ?? "—", phone: institution?.adminPhone ?? null,
      classLabel: null, addedBy: addedByEmail.get(a.email) ?? null,
    });
  }
  for (const sa of subAdmins) {
    pushIfExisted({
      userId: sa.user.id, name: sa.user.name, email: sa.user.email, createdAt: sa.user.createdAt, isActive: sa.user.isActive,
      role: "SUB_ADMIN", businessId: sa.user.displayId ?? "—", phone: sa.phone,
      classLabel: null, addedBy: addedByEmail.get(sa.user.email) ?? null,
    });
  }
  for (const t of teachers) {
    const u = personUsers.get(t.userId);
    if (!u) continue; // orphaned academic row with no central user — skip
    pushIfExisted({
      userId: u.id, name: u.name, email: u.email, createdAt: u.createdAt, isActive: u.isActive,
      role: "TEACHER", businessId: t.teacherId, phone: t.phone,
      classLabel: null, addedBy: addedByEmail.get(u.email) ?? null,
    });
  }
  for (const s of students) {
    const u = personUsers.get(s.userId);
    if (!u) continue; // orphaned academic row with no central user — skip
    const classLabel = s.division ? s.division.name : null;
    pushIfExisted({
      userId: u.id, name: u.name, email: u.email, createdAt: u.createdAt, isActive: u.isActive,
      role: "STUDENT", businessId: s.studentId, phone: s.phone,
      classLabel, addedBy: addedByEmail.get(u.email) ?? null,
    });
  }

  return results;
}
