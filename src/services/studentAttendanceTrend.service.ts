import { prisma } from "../utils/prisma";

export interface AttendanceMonthData { month: string; key: number; year: number; present: number; absent: number; leave: number; total: number; pct: number | null }

export interface StudentAttendanceTrendData {
  academicYear: string;
  startYear: number;
  overall: { present: number; absent: number; leave: number; total: number; pct: number | null };
  monthly: AttendanceMonthData[];
}

const ACADEMIC_MONTH_DEFS = [
  { month: "Jun", key: 5 },
  { month: "Jul", key: 6 },
  { month: "Aug", key: 7 },
  { month: "Sep", key: 8 },
  { month: "Oct", key: 9 },
  { month: "Nov", key: 10 },
  { month: "Dec", key: 11 },
  { month: "Jan", key: 0 },
  { month: "Feb", key: 1 },
  { month: "Mar", key: 2 },
  { month: "Apr", key: 3 },
  { month: "May", key: 4 },
];

export async function getStudentAttendanceTrendData(
  studentId: string,
  institutionId: string
): Promise<StudentAttendanceTrendData> {
  const now = new Date();
  const curMonth = now.getMonth();
  const curYear = now.getFullYear();
  const startYear = curMonth >= 5 ? curYear : curYear - 1;
  const academicYear = `${startYear}-${String(startYear + 1).slice(2)}`;
  const startDate = `${startYear}-06-01`;
  const endDate = `${startYear + 1}-05-31`;

  const records = await prisma.attendance.findMany({
    where: { studentId, institutionId, date: { gte: startDate, lte: endDate } },
    select: { date: true, status: true },
  });

  let totalPresent = 0, totalAbsent = 0, totalLeave = 0, totalRecords = 0;

  const monthly: AttendanceMonthData[] = ACADEMIC_MONTH_DEFS.map(({ month, key }) => {
    const mYear = key >= 5 ? startYear : startYear + 1;
    const paddedMonth = String(key + 1).padStart(2, "0");
    const prefix = `${mYear}-${paddedMonth}`;
    const mRecords = records.filter((r) => r.date.startsWith(prefix));
    const p = mRecords.filter((r) => r.status === "P").length;
    const a = mRecords.filter((r) => r.status === "A").length;
    const l = mRecords.filter((r) => r.status === "L").length;
    const total = p + a + l;
    const pct = total > 0 ? Math.round(((p + l) / total) * 100) : null;
    totalPresent += p; totalAbsent += a; totalLeave += l; totalRecords += total;
    return { month, key, year: mYear, present: p, absent: a, leave: l, total, pct };
  });

  const overallPct = totalRecords > 0
    ? Math.round(((totalPresent + totalLeave) / totalRecords) * 100)
    : null;

  return {
    academicYear,
    startYear,
    overall: { present: totalPresent, absent: totalAbsent, leave: totalLeave, total: totalRecords, pct: overallPct },
    monthly,
  };
}
