// src/modules/teacher/overview.controller.ts
import { Response, NextFunction } from "express";
import { AuthRequest } from "../../middlewares/auth.middleware";
import { prisma } from "../../utils/prisma";

function calcPct(present: number, absent: number, late: number): number | null {
  const total = present + absent + late;
  return total > 0 ? Math.round(((present + late) / total) * 100) : null;
}

export async function getOverview(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { userId, institutionId } = req.user!;
    if (!institutionId) {
      res.status(400).json({ success: false, error: "No institution associated with this account" });
      return;
    }

    const teacher = await prisma.teacher.findFirst({
      where: { userId, institutionId },
      include: {
        user: { select: { name: true } },
        institution: { select: { name: true } },
      },
    });
    if (!teacher) {
      res.status(404).json({ success: false, error: "Teacher profile not found" });
      return;
    }

    const [assignmentRows, testsConducted, classTeacherDivision, auditLogRows] = await Promise.all([
      prisma.divisionAssignment.findMany({
        where: { teacherId: teacher.id, institutionId },
        select: { divisionId: true, subjectId: true },
      }),
      prisma.taskTest.count({
        where: { teacherId: teacher.id, institutionId, status: { in: ["ACTIVE", "COMPLETED"] } },
      }),
      prisma.division.findFirst({
        where: { institutionId, classTeacherId: teacher.id },
        select: { id: true, name: true, standard: { select: { name: true } } },
      }),
      prisma.auditLog.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        take: 6,
        select: { id: true, action: true, category: true, severity: true, details: true, ip: true, createdAt: true },
      }),
    ]);

    const classesAssigned = new Set(assignmentRows.map((a) => a.divisionId)).size;
    const subjectsTeaching = new Set(
      assignmentRows.filter((a) => a.subjectId).map((a) => a.subjectId)
    ).size;

    let avgAttendancePct: number | null = null;
    let attendanceTrend: { month: string; attendance: number; students: number }[] = [];
    let shortAttendance: { name: string; rollNo: string; pct: number }[] = [];

    if (classTeacherDivision) {
      const divisionId = classTeacherDivision.id;

      const [allRecords, students] = await Promise.all([
        prisma.attendance.findMany({
          where: { divisionId, institutionId },
          select: { studentId: true, date: true, status: true },
        }),
        prisma.student.findMany({
          where: { divisionId, institutionId },
          select: { id: true, rollNo: true, user: { select: { name: true } } },
        }),
      ]);

      // ── Class-wide average (straight ratio across all records) ──
      let tP = 0, tA = 0, tL = 0;
      allRecords.forEach((r) => {
        if (r.status === "P") tP++;
        else if (r.status === "A") tA++;
        else if (r.status === "L") tL++;
      });
      avgAttendancePct = calcPct(tP, tA, tL);

      // ── 12-month academic-year trend (Jun 1 -> May 31) ──
      const now = new Date();
      const curMonth = now.getMonth();
      const curYear = now.getFullYear();
      const startYear = curMonth >= 5 ? curYear : curYear - 1;

      attendanceTrend = Array.from({ length: 12 }, (_, i) => {
        const d = new Date(startYear, 5 + i, 1); // Jun = index 5
        const monthKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
        const recs = allRecords.filter((r) => r.date.startsWith(monthKey));
        let p = 0, a = 0, l = 0;
        const studentIds = new Set<string>();
        recs.forEach((r) => {
          studentIds.add(r.studentId);
          if (r.status === "P") p++;
          else if (r.status === "A") a++;
          else if (r.status === "L") l++;
        });
        const pct = calcPct(p, a, l);
        return {
          month: d.toLocaleString("en-US", { month: "short" }),
          attendance: pct ?? 0,
          students: studentIds.size,
        };
      });

      // ── Per-student overall pct, filtered < 75% ──
      const byStudent: Record<string, { p: number; a: number; l: number }> = {};
      allRecords.forEach((r) => {
        if (!byStudent[r.studentId]) byStudent[r.studentId] = { p: 0, a: 0, l: 0 };
        if (r.status === "P") byStudent[r.studentId].p++;
        else if (r.status === "A") byStudent[r.studentId].a++;
        else if (r.status === "L") byStudent[r.studentId].l++;
      });

      shortAttendance = students
        .map((s) => {
          const c = byStudent[s.id] ?? { p: 0, a: 0, l: 0 };
          const pct = calcPct(c.p, c.a, c.l);
          return { name: s.user.name ?? "Unknown", rollNo: s.rollNo ?? "", pct };
        })
        .filter((s): s is { name: string; rollNo: string; pct: number } => s.pct !== null && s.pct < 75)
        .sort((a, b) => a.pct - b.pct);
    }

    res.json({
      success: true,
      data: {
        teacher: {
          name: teacher.user.name ?? "",
          institutionName: teacher.institution.name,
          classTeacherDivisionName: classTeacherDivision
            ? `${classTeacherDivision.standard.name} - ${classTeacherDivision.name}`
            : null,
        },
        stats: {
          classesAssigned,
          subjectsTeaching,
          testsConducted,
          avgAttendancePct,
        },
        attendanceTrend,
        shortAttendance,
        auditLogs: auditLogRows.map((l) => ({ ...l, createdAt: l.createdAt.toISOString() })),
      },
    });
  } catch (err) {
    next(err);
  }
}
