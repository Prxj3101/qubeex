import { academicDb } from "../utils/academicContext";
import { resolveUsers } from "./userLookup.service";

export interface AttendanceMonthDetail { month: string; key: number; year: number; present: number; absent: number; leave: number; total: number; pct: number | null }
export interface AttendanceHoliday { date: string; name: string }

export interface StudentAttendanceDetailData {
  academicYear: string;
  startYear: number;
  overall: { present: number; absent: number; leave: number; total: number; pct: number | null };
  monthly: AttendanceMonthDetail[];
  daily: Record<string, string>;
  holidays: AttendanceHoliday[];
  student: { name: string | null; rollNo: string };
}

const ACADEMIC_MONTHS = [
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

// Full attendance detail (monthly breakdown + daily P/A/L sheet + holidays)
// for one specific student, over the current academic session (June–May).
// This is the same shape /student/attendance returns for the logged-in
// student — reused here so admin/teacher "View Details" pages can show the
// identical real-time attendance sheet for any student they have access to.
export async function getStudentAttendanceDetailData(
  studentId: string,
  institutionId: string
): Promise<StudentAttendanceDetailData> {
  const student = await academicDb().student.findFirst({
    where: { id: studentId, institutionId },
    select: { rollNo: true, userId: true },
  });
  const studentName = student
    ? (await resolveUsers([student.userId], { id: true, name: true })).get(student.userId)?.name ?? null
    : null;

  const now = new Date();
  const curMonth = now.getMonth();
  const curYear = now.getFullYear();
  const startYear = curMonth >= 5 ? curYear : curYear - 1;
  const academicYear = `${startYear}-${String(startYear + 1).slice(2)}`;
  const startDate = `${startYear}-06-01`;
  const endDate = `${startYear + 1}-05-31`;

  const [records, holidays] = await Promise.all([
    academicDb().attendance.findMany({
      where: { studentId, institutionId, date: { gte: startDate, lte: endDate } },
      select: { date: true, status: true },
    }),
    academicDb().schoolHoliday.findMany({
      where: { institutionId, date: { gte: startDate, lte: endDate } },
      select: { date: true, name: true },
    }),
  ]);

  const daily: Record<string, string> = {};
  for (const r of records) daily[r.date] = r.status;

  let totalPresent = 0, totalAbsent = 0, totalLeave = 0, totalRecords = 0;

  const monthly: AttendanceMonthDetail[] = ACADEMIC_MONTHS.map(({ month, key }) => {
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
    daily,
    holidays,
    student: { name: studentName, rollNo: student?.rollNo ?? "" },
  };
}
