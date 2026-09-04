// ── AI School PA — tool executors ───────────────────────────────────────────
// Each function here is a "tool" the assistant's model can call by name to
// answer an admin's question about their own institution. Every function
// takes only `institutionId` (never trusts anything the model or the client
// sends as an institution scope) and returns a small, pre-summarized JSON
// object — never raw rows — both to keep the round-trip token cost sane and
// to avoid ever handing the model a student-level data dump it could repeat
// back verbatim into a screen-shareable chat transcript.
//
// Deliberately independent, lighter-weight re-implementations rather than
// reuse of the full dashboard pipelines (getAttendanceInsights/
// getParentEngagementInsights in insights.controller.ts) — those are tuned
// for exact chart parity, order of magnitude more code, and not exported as
// pure functions. The assistant only needs directionally-correct numbers to
// talk about, not the exact same rounding the dashboard uses.
import { academicDb } from "../utils/academicContext";
import { prisma } from "../utils/prisma";
import { resolveUsers } from "./userLookup.service";
import { computeInstitutionFeeStats } from "./feeInsights.service";
import { getInstitutionTeacherBreakdown } from "./ai-usage.service";

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: { type: "object"; properties: Record<string, unknown>; required?: string[] };
}

// OpenAI function-calling tool schemas. No parameters needed for any of
// these today — every tool is scoped to "this institution, right now" — but
// each still declares an (empty) parameters object since the API requires one.
export const SCHOOL_ASSISTANT_TOOLS: ToolDefinition[] = [
  {
    name: "getAttendanceOverview",
    description: "Get this institution's current attendance snapshot: overall and this-month attendance rate, and the 3 divisions with the lowest this-month attendance.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "getFeeOverview",
    description: "Get this institution's fee collection snapshot: this-month and overall (year) fee collection rate, based on how many students have paid vs. total students.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "getDisengagedParents",
    description: "Get the list (count + up to 10 names) of students whose family hasn't opened Parent Mode on the app in 15+ days, or never at all.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "getStaffAiUsage",
    description: "Get which teachers are using the school's AI tools (Blackboard AI Scan/Chat/Quiz/Mindmap) the most and least this month, by total tokens used.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "getInstitutionProfile",
    description: "Get this institution's own profile: name, board/medium, type, address, contact info, established date, and headcounts (students/teachers/classes).",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "getStaffDirectory",
    description: "Look up staff at this institution — the admin, sub-admins (with their designation and exactly which permissions/access each one has), and teachers. Pass `query` as a teacher/staff name, a subject, a class like '10-A', or the bare word 'subadmin'/'admin'/'teacher' to list that whole role — always prefer this when the question names someone, something, or a role specific. Omit `query` only for a genuinely broad 'list all staff' question, which returns every teacher's name/title and every sub-admin with their permissions (without teachers' full subject/class breakdown, to keep the answer compact).",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "A staff name, subject, class/division name, or a role word ('subadmin', 'admin', 'teacher') to filter by. Omit for a full compact staff list." } },
    },
  },
  {
    name: "getClassStructure",
    description: "Get this institution's academic structure. Pass `standard` (e.g. '10' or 'Class 10') to get just that grade's divisions, student counts, and subjects — prefer this when a specific class is named. Omit `standard` only for a broad overview, which returns every standard's name and total student count without the full division/subject breakdown.",
    parameters: {
      type: "object",
      properties: { standard: { type: "string", description: "A specific standard/grade name to filter to, e.g. '10'. Omit for a compact overview of all standards." } },
    },
  },
  {
    name: "getStudentLookup",
    description: "Look up a specific student by name or roll/student ID and get their class, roll number, attendance rate, and fee payment status. Use this for any question about one named student.",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "The student's name (full or partial) or their roll/student ID." } },
      required: ["query"],
    },
  },
  {
    name: "getUpcomingHolidays",
    description: "Get the next upcoming school holidays on this institution's calendar.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "getRecentCampusFeedPosts",
    description: "Get the most recent posts on this institution's campus feed (announcements, notices, etc.) — title, type, who posted it, which class it's for (or whole school), and when. Use this for any question about recent posts, announcements, or notices.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "getUpcomingCalendarEvents",
    description: "Get upcoming events on this institution's school calendar (exams, PTMs, functions, etc. — separate from holidays). Use this for any question about what's coming up on the calendar/schedule.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "getFeeDefaultersByClass",
    description: "Get the list of students in one specific class/division (e.g. '10-A') who haven't paid this month's fee yet. Use this whenever a question asks which/who has pending fees in a particular class.",
    parameters: {
      type: "object",
      properties: { className: { type: "string", description: "The class/division to check, e.g. '10-A' or '10 A'." } },
      required: ["className"],
    },
  },
];

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export async function getAttendanceOverview(institutionId: string) {
  const db = academicDb();
  const now = new Date();
  const monthPrefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  const divisions = await db.division.findMany({
    where: { institutionId },
    select: {
      id: true,
      name: true,
      standard: { select: { name: true } },
      students: { where: { status: "ACTIVE" }, select: { id: true } },
    },
  });
  if (divisions.length === 0) {
    return { overallRatePct: null, thisMonthRatePct: null, worstDivisions: [], note: "No classes/divisions set up yet." };
  }

  const [rows, holidays] = await Promise.all([
    db.attendance.findMany({
      where: { institutionId },
      select: { studentId: true, divisionId: true, date: true, status: true },
    }),
    db.schoolHoliday.findMany({ where: { institutionId }, select: { date: true } }),
  ]);
  const holidayDates = new Set(holidays.map((h) => h.date));

  // Present is P or L (L = Late, still counts toward attendance rate, same as
  // the Analytics dashboard) — and holidays never count as a taken day.
  const byStudent = new Map<string, { date: string; status: string }[]>();
  for (const r of rows) {
    if (holidayDates.has(r.date)) continue;
    const arr = byStudent.get(r.studentId) ?? [];
    arr.push({ date: r.date, status: r.status });
    byStudent.set(r.studentId, arr);
  }

  function studentPcts(studentId: string): { overallPct: number | null; monthPct: number | null } {
    const recs = byStudent.get(studentId) ?? [];
    const monthRecs = recs.filter((r) => r.date.startsWith(monthPrefix));
    const monthPct = monthRecs.length > 0
      ? round1((monthRecs.filter((r) => r.status === "P" || r.status === "L").length / monthRecs.length) * 100)
      : null;
    const overallPct = recs.length > 0
      ? round1((recs.filter((r) => r.status === "P" || r.status === "L").length / recs.length) * 100)
      : null;
    return { overallPct, monthPct };
  }

  function avg(nums: (number | null)[]): number | null {
    const valid = nums.filter((n): n is number => n !== null);
    return valid.length > 0 ? round1(valid.reduce((a, b) => a + b, 0) / valid.length) : null;
  }

  const divisionPcts = divisions.map((d) => {
    const pcts = d.students.map((st) => studentPcts(st.id));
    return {
      name: `${d.standard.name} - ${d.name}`,
      overallPct: avg(pcts.map((p) => p.overallPct)),
      monthPct: avg(pcts.map((p) => p.monthPct)),
    };
  });

  const withOverall = divisionPcts.filter((d) => d.overallPct !== null) as { name: string; overallPct: number; monthPct: number | null }[];
  const withMonth = divisionPcts.filter((d) => d.monthPct !== null) as { name: string; overallPct: number | null; monthPct: number }[];

  const overallRatePct = withOverall.length > 0 ? round1(withOverall.reduce((s, d) => s + d.overallPct, 0) / withOverall.length) : null;
  const thisMonthRatePct = withMonth.length > 0 ? round1(withMonth.reduce((s, d) => s + d.monthPct, 0) / withMonth.length) : null;

  const worstDivisions = withMonth
    .slice()
    .sort((a, b) => a.monthPct - b.monthPct)
    .slice(0, 3)
    .map((d) => ({ division: d.name, thisMonthRatePct: d.monthPct }));

  return { overallRatePct, thisMonthRatePct, worstDivisions };
}

export async function getFeeOverview(institutionId: string) {
  const db = academicDb();
  const stats = await computeInstitutionFeeStats(db, institutionId);
  return {
    studentCount: stats.studentCount,
    thisMonthCollectionRatePct: stats.monthlyTotal > 0 ? round1((stats.monthlyPaid / stats.monthlyTotal) * 100) : null,
    overallCollectionRatePct: stats.overallTotal > 0 ? round1((stats.overallPaid / stats.overallTotal) * 100) : null,
    last6MonthsTrend: stats.historical,
  };
}

const DISENGAGED_THRESHOLD_DAYS = 15;

export async function getDisengagedParents(institutionId: string) {
  const db = academicDb();
  const students = await db.student.findMany({
    where: { institutionId, status: "ACTIVE" },
    select: { id: true, userId: true, standard: { select: { name: true } }, division: { select: { name: true } } },
  });
  if (students.length === 0) return { count: 0, examples: [] };

  const events = await db.parentModeEvent.groupBy({
    by: ["studentId"],
    where: { institutionId },
    _max: { openedAt: true },
  });
  const lastOpenByStudent = new Map(events.map((e) => [e.studentId, e._max.openedAt]));
  const now = Date.now();

  const candidates = students
    .filter((s) => s.standard && s.division)
    .map((s) => {
      const lastOpen = lastOpenByStudent.get(s.id) ?? null;
      const daysSince = lastOpen ? Math.floor((now - lastOpen.getTime()) / (1000 * 60 * 60 * 24)) : null;
      return { student: s, daysSince };
    })
    .filter((c) => c.daysSince === null || c.daysSince >= DISENGAGED_THRESHOLD_DAYS);

  const top = candidates
    .slice()
    .sort((a, b) => (b.daysSince ?? 9999) - (a.daysSince ?? 9999))
    .slice(0, 10);
  const userMap = await resolveUsers(top.map((c) => c.student.userId), { id: true, name: true });

  const examples = top.map((c) => ({
    name: userMap.get(c.student.userId)?.name ?? "Unknown",
    class: `${c.student.standard!.name} - ${c.student.division!.name}`,
    daysSinceLastOpen: c.daysSince,
  }));

  return { count: candidates.length, examples };
}

export async function getStaffAiUsage(institutionId: string) {
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth(), 1);
  const summaries = await getInstitutionTeacherBreakdown(institutionId, from, now);
  if (summaries.length === 0) return { teachers: [] };

  const teachers = await prisma.teacher.findMany({
    where: { id: { in: summaries.map((s) => s.teacherId) }, institutionId },
    select: { id: true, userId: true },
  });
  const userMap = await resolveUsers(teachers.map((t) => t.userId), { id: true, name: true });
  const nameByTeacherId = new Map(teachers.map((t) => [t.id, userMap.get(t.userId)?.name ?? "Unknown"]));

  const sorted = summaries.slice().sort((a, b) => b.totalTokens - a.totalTokens);
  return {
    teachers: sorted.map((s) => ({
      name: nameByTeacherId.get(s.teacherId) ?? "Unknown",
      totalTokensThisMonth: s.totalTokens,
      requestsThisMonth: s.totalRequests,
      overSoftLimit: s.isOverSoftLimit,
    })),
  };
}

export async function getInstitutionProfile(institutionId: string) {
  const [inst, db] = [await prisma.institution.findUnique({ where: { id: institutionId } }), academicDb()];
  if (!inst) return { error: "Institution not found" };

  const [studentCount, teacherCount, divisionCount] = await Promise.all([
    db.student.count({ where: { institutionId, status: "ACTIVE" } }),
    db.teacher.count({ where: { institutionId } }),
    db.division.count({ where: { institutionId } }),
  ]);

  return {
    name: inst.name,
    type: inst.type,
    board: inst.board,
    medium: inst.medium,
    address: [inst.address, inst.city, inst.state, inst.pincode].filter(Boolean).join(", ") || null,
    phone: inst.phone,
    establishedOn: inst.establishedOn,
    activeStudentCount: studentCount,
    teacherCount,
    divisionCount,
  };
}

// Strips spaces/hyphens so "sub-admin", "sub admin", and "subadmin" all
// normalize the same way — the model (and users) phrase this inconsistently,
// and a plain substring match on "subadmin" vs a designation of "Sub-Admin"
// was failing to match, making the assistant wrongly report no sub-admins
// existed even when they did.
const normalizeForMatch = (s: string) => s.toLowerCase().replace(/[\s-]+/g, "");

const ROLE_CATEGORY_KEYWORDS: Record<string, "admin" | "subadmin" | "teacher"> = {
  admin: "admin",
  administrator: "admin",
  subadmin: "subadmin",
  teacher: "teacher",
  teachers: "teacher",
};

export async function getStaffDirectory(institutionId: string, args: { query?: string } = {}) {
  const rawQuery = (args.query ?? "").trim();
  const query = rawQuery.toLowerCase();
  const normalizedQuery = normalizeForMatch(rawQuery);
  const roleCategory = ROLE_CATEGORY_KEYWORDS[normalizedQuery];
  const db = academicDb();
  const [inst, subAdmins, teachers, assignments] = await Promise.all([
    prisma.institution.findUnique({ where: { id: institutionId }, select: { adminPrefix: true, adminTitle: true, users: { where: { role: "ADMIN" }, select: { id: true, name: true } } } }),
    prisma.subAdmin.findMany({ where: { institutionId }, select: { userId: true, designation: true, prefix: true, permissions: true } }),
    db.teacher.findMany({ where: { institutionId }, select: { id: true, userId: true, title: true } }),
    db.divisionAssignment.findMany({
      where: { institutionId },
      select: { teacherId: true, subject: { select: { name: true } }, division: { select: { name: true, standard: { select: { name: true } } } } },
    }),
  ]);

  const adminUser = inst?.users[0];
  const allUserIds = [adminUser?.id, ...subAdmins.map((s) => s.userId), ...teachers.map((t) => t.userId)];
  const userMap = await resolveUsers(allUserIds, { id: true, name: true });

  const teachingByTeacher = new Map<string, string[]>();
  for (const a of assignments) {
    if (!a.subject || !a.division) continue;
    const label = `${a.subject.name} (${a.division.standard.name} - ${a.division.name})`;
    const arr = teachingByTeacher.get(a.teacherId) ?? [];
    arr.push(label);
    teachingByTeacher.set(a.teacherId, arr);
  }

  const admin = adminUser ? { name: userMap.get(adminUser.id)?.name ?? adminUser.name, title: inst?.adminTitle ?? "Admin" } : null;
  // permissions included by default on every sub-admin — this is exactly the
  // "who has access to what" answer, and the list is short enough that
  // there's no real token cost to always including it.
  const allSubAdmins = subAdmins.map((s) => ({
    name: userMap.get(s.userId)?.name ?? "Unknown",
    designation: s.designation ?? "Sub-Admin",
    permissions: s.permissions.length > 0 ? s.permissions : ["No specific permissions assigned yet"],
  }));
  const allTeachers = teachers.map((t) => ({
    name: userMap.get(t.userId)?.name ?? "Unknown",
    title: t.title ?? "Teacher",
    teaches: teachingByTeacher.get(t.id) ?? [],
  }));

  // No query — this is a broad "list everyone" ask, so keep the payload
  // small by dropping each teacher's full subject/class breakdown. Still
  // includes sub-admin permissions since that list is already tiny.
  if (!query) {
    return {
      admin,
      subAdmins: allSubAdmins,
      teachers: allTeachers.map((t) => ({ name: t.name, title: t.title })),
      note: "Ask about a specific teacher, subject, or class to see who teaches what.",
    };
  }

  // A bare role-category word ("subadmin", "admin", "teacher(s)") means
  // "show me everyone in that role", not a name/designation substring search
  // — handle it as its own case before falling through to the name match
  // below, which would otherwise miss e.g. a subadmin whose designation
  // doesn't literally contain the word "subadmin".
  if (roleCategory === "subadmin") {
    return {
      subAdmins: allSubAdmins,
      ...(allSubAdmins.length === 0 ? { note: "No sub-admins have been added for this institution yet." } : {}),
    };
  }
  if (roleCategory === "admin") {
    return { admin };
  }
  if (roleCategory === "teacher") {
    return { teachers: allTeachers };
  }

  // Query given — return only what actually matches (by name, subject, or
  // class/division), full detail included since the result set is small.
  const matchedTeachers = allTeachers.filter((t) =>
    t.name.toLowerCase().includes(query) ||
    t.teaches.some((label) => label.toLowerCase().includes(query))
  );
  const matchedSubAdmins = allSubAdmins.filter((s) =>
    s.name.toLowerCase().includes(query) || normalizeForMatch(s.designation).includes(normalizedQuery)
  );
  const adminMatches = admin && admin.name?.toLowerCase().includes(query);

  return {
    admin: adminMatches ? admin : null,
    subAdmins: matchedSubAdmins,
    teachers: matchedTeachers,
    ...(matchedTeachers.length === 0 && matchedSubAdmins.length === 0 && !adminMatches ? { note: "No staff matched that." } : {}),
  };
}

export async function getClassStructure(institutionId: string, args: { standard?: string } = {}) {
  const filter = (args.standard ?? "").trim().toLowerCase();
  const db = academicDb();
  const standards = await db.standard.findMany({
    where: { institutionId },
    orderBy: { order: "asc" },
    select: {
      name: true,
      divisions: {
        select: {
          name: true,
          students: { where: { status: "ACTIVE" }, select: { id: true } },
          divisionSubjects: { select: { subject: { select: { name: true } } } },
        },
      },
    },
  });

  // No filter — broad overview, so skip the per-division subject breakdown
  // (that's the bulky part) and just give standard-level totals.
  if (!filter) {
    return {
      standards: standards.map((s) => ({
        name: s.name,
        divisionCount: s.divisions.length,
        activeStudentCount: s.divisions.reduce((sum, d) => sum + d.students.length, 0),
      })),
      note: "Ask about a specific standard/class to see its divisions and subjects.",
    };
  }

  const matched = standards.filter((s) => s.name.toLowerCase().includes(filter));
  if (matched.length === 0) return { note: "No standard matched that." };

  return {
    standards: matched.map((s) => ({
      name: s.name,
      divisions: s.divisions.map((d) => ({
        name: d.name,
        activeStudentCount: d.students.length,
        subjects: d.divisionSubjects.map((ds) => ds.subject.name),
      })),
    })),
  };
}

export async function getStudentLookup(institutionId: string, args: { query?: string } = {}) {
  const query = (args.query ?? "").trim();
  if (!query) return { error: "No student name or ID given." };
  const db = academicDb();

  // Try matching by name first (central User table), then fall back to
  // roll/student ID (tenant Student table) — covers both ways an admin
  // is likely to refer to a student.
  const nameMatches = await prisma.user.findMany({
    where: { institutionId, role: "STUDENT", name: { contains: query, mode: "insensitive" } },
    select: { id: true, name: true },
    take: 5,
  });

  let students;
  if (nameMatches.length > 0) {
    students = await db.student.findMany({
      where: { institutionId, userId: { in: nameMatches.map((u) => u.id) } },
      select: { id: true, userId: true, rollNo: true, studentId: true, standard: { select: { name: true } }, division: { select: { name: true } } },
    });
  } else {
    students = await db.student.findMany({
      where: { institutionId, OR: [{ rollNo: { contains: query, mode: "insensitive" } }, { studentId: { contains: query, mode: "insensitive" } }] },
      select: { id: true, userId: true, rollNo: true, studentId: true, standard: { select: { name: true } }, division: { select: { name: true } } },
      take: 5,
    });
  }

  if (students.length === 0) return { found: false, note: "No student matched that name/ID." };
  if (students.length > 1) {
    const userMap = await resolveUsers(students.map((s) => s.userId), { id: true, name: true });
    return {
      found: true,
      multipleMatches: true,
      matches: students.map((s) => ({ name: userMap.get(s.userId)?.name ?? "Unknown", class: s.standard && s.division ? `${s.standard.name} - ${s.division.name}` : null })),
    };
  }

  const student = students[0];
  const userMap = await resolveUsers([student.userId], { id: true, name: true });
  const now = new Date();
  const monthPrefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  const [attendanceRecs, feePayments] = await Promise.all([
    db.attendance.findMany({ where: { studentId: student.id }, select: { date: true, status: true } }),
    db.studentFeePayment.findMany({ where: { studentId: student.id }, select: { status: true } }),
  ]);
  const monthRecs = attendanceRecs.filter((r) => r.date.startsWith(monthPrefix));
  const monthAttendancePct = monthRecs.length > 0
    ? round1((monthRecs.filter((r) => r.status === "P" || r.status === "L").length / monthRecs.length) * 100)
    : null;
  const paidCount = feePayments.filter((f) => f.status === "PAID").length;

  return {
    found: true,
    name: userMap.get(student.userId)?.name ?? "Unknown",
    rollNo: student.rollNo,
    studentId: student.studentId,
    class: student.standard && student.division ? `${student.standard.name} - ${student.division.name}` : null,
    thisMonthAttendancePct: monthAttendancePct,
    feePaymentsThisYear: `${paidCount} paid / ${feePayments.length} due`,
  };
}

export async function getUpcomingHolidays(institutionId: string) {
  const db = academicDb();
  const todayStr = new Date().toISOString().slice(0, 10);
  const holidays = await db.schoolHoliday.findMany({
    where: { institutionId, date: { gte: todayStr } },
    orderBy: { date: "asc" },
    take: 8,
    select: { date: true, name: true },
  });
  return { upcoming: holidays };
}

export async function getRecentCampusFeedPosts(institutionId: string) {
  const db = academicDb();
  const posts = await db.campusFeedPost.findMany({
    where: { institutionId },
    orderBy: { createdAt: "desc" },
    take: 8,
    select: {
      authorId: true,
      type: true,
      title: true,
      body: true,
      createdAt: true,
      division: { select: { name: true, standard: { select: { name: true } } } },
    },
  });
  if (posts.length === 0) return { posts: [], note: "No campus feed posts yet." };

  const userMap = await resolveUsers(posts.map((p) => p.authorId), { id: true, name: true });
  return {
    posts: posts.map((p) => ({
      title: p.title,
      type: p.type,
      by: userMap.get(p.authorId)?.name ?? "Unknown",
      class: p.division ? `${p.division.standard.name} - ${p.division.name}` : "Whole school",
      postedAt: p.createdAt.toISOString().slice(0, 10),
      excerpt: p.body.length > 140 ? `${p.body.slice(0, 140)}…` : p.body,
    })),
  };
}

export async function getUpcomingCalendarEvents(institutionId: string) {
  const db = academicDb();
  const events = await db.calendarEvent.findMany({
    where: { institutionId, date: { gte: new Date() } },
    orderBy: { date: "asc" },
    take: 8,
    select: { type: true, label: true, date: true, division: { select: { name: true, standard: { select: { name: true } } } } },
  });
  return {
    upcoming: events.map((e) => ({
      label: e.label,
      type: e.type,
      date: e.date.toISOString().slice(0, 10),
      class: e.division ? `${e.division.standard.name} - ${e.division.name}` : "Whole school",
    })),
  };
}

function dueDateMs(dueDate: string): number {
  const t = new Date(dueDate).getTime();
  return Number.isNaN(t) ? Infinity : t;
}

export async function getFeeDefaultersByClass(institutionId: string, args: { className?: string } = {}) {
  const className = (args.className ?? "").trim();
  if (!className) return { error: "No class specified." };
  const db = academicDb();

  const divisions = await db.division.findMany({
    where: { institutionId },
    select: {
      id: true,
      name: true,
      standard: { select: { name: true } },
      feeStructure: { select: { feeMonths: true } },
      students: { where: { status: "ACTIVE" }, select: { id: true, userId: true, rollNo: true } },
    },
  });

  const normalize = (s: string) => s.toLowerCase().replace(/[\s-]/g, "");
  const target = normalize(className);
  const match = divisions.find((d) => normalize(`${d.standard.name}${d.name}`).includes(target));
  if (!match) return { note: "No class matched that." };

  const months = (match.feeStructure?.feeMonths as { id: string; month: string; dueDate: string }[] | null) ?? [];
  if (months.length === 0) return { class: `${match.standard.name} - ${match.name}`, note: "No fee structure set up for this class yet." };

  const now = Date.now();
  const sorted = [...months].sort((a, b) => dueDateMs(a.dueDate) - dueDateMs(b.dueDate));
  const past = sorted.filter((m) => dueDateMs(m.dueDate) <= now);
  const currentMonthName = new Date().toLocaleDateString("en-US", { timeZone: "Asia/Kolkata", month: "long" });
  const currentMonth = months.find((m) => m.month === currentMonthName) ?? (past.length > 0 ? past[past.length - 1] : sorted[0]) ?? null;
  if (!currentMonth) return { class: `${match.standard.name} - ${match.name}`, note: "No current fee month found." };

  const payments = match.students.length
    ? await db.studentFeePayment.findMany({
        where: { institutionId, feeMonthId: currentMonth.id, status: "PAID", studentId: { in: match.students.map((s) => s.id) } },
        select: { studentId: true },
      })
    : [];
  const paidSet = new Set(payments.map((p) => p.studentId));
  const pendingStudents = match.students.filter((s) => !paidSet.has(s.id));
  const userMap = await resolveUsers(pendingStudents.slice(0, 20).map((s) => s.userId), { id: true, name: true });

  return {
    class: `${match.standard.name} - ${match.name}`,
    month: currentMonth.month,
    totalStudents: match.students.length,
    pendingCount: pendingStudents.length,
    pendingStudents: pendingStudents.slice(0, 20).map((s) => ({ name: userMap.get(s.userId)?.name ?? "Unknown", rollNo: s.rollNo })),
  };
}

export const SCHOOL_ASSISTANT_EXECUTORS: Record<string, (institutionId: string, args?: Record<string, unknown>) => Promise<unknown>> = {
  getAttendanceOverview,
  getFeeOverview,
  getDisengagedParents,
  getStaffAiUsage,
  getInstitutionProfile,
  getStaffDirectory,
  getClassStructure,
  getStudentLookup,
  getUpcomingHolidays,
  getFeeDefaultersByClass,
  getRecentCampusFeedPosts,
  getUpcomingCalendarEvents,
};
