import cron from "node-cron";
import { prisma } from "../utils/prisma";
import { recordCronRun } from "../services/cronTracker.service";
import { createNotification } from "../services/notification.service";

// Managed institutions only — BYOD tenants keep TaskTest/TaskAssignment in
// their own database, and no cron here iterates per-tenant connections yet
// (same scope limit as every other cron in this file). See BYOD status notes.
const REMINDER_WINDOW_MS = 24 * 60 * 60 * 1000; // notify once a deadline is within 24h

async function notifyDivisionStudents(institutionId: string, divisionId: string, title: string, message: string, tag: string) {
  const students = await prisma.student.findMany({ where: { divisionId, institutionId }, select: { userId: true } });
  if (students.length === 0) return;

  await createNotification({
    title,
    message,
    tag,
    recipientType: "SYSTEM",
    recipients: students.map((s) => ({ institutionId, userId: s.userId })),
  });
}

async function runTestDeadlineReminders() {
  const now = new Date();
  const windowEnd = new Date(now.getTime() + REMINDER_WINDOW_MS);

  const tests = await prisma.taskTest.findMany({
    where: { status: "ACTIVE", deadlineReminderSent: false, validUntil: { gte: now, lte: windowEnd } },
    select: { id: true, institutionId: true, divisionId: true, title: true, validUntil: true },
  });

  for (const test of tests) {
    try {
      await notifyDivisionStudents(
        test.institutionId,
        test.divisionId,
        `Test closing soon: ${test.title}`,
        `"${test.title}" closes on ${test.validUntil!.toLocaleDateString("en-IN")} — make sure to attempt it before then.`,
        "EXAM_REMINDER"
      );
      await prisma.taskTest.update({ where: { id: test.id }, data: { deadlineReminderSent: true } });
    } catch (err) {
      console.error(`[Deadline Reminder Cron] Test reminder failed for ${test.id}:`, err);
    }
  }

  console.log(`[Deadline Reminder Cron] Sent ${tests.length} test deadline reminder(s)`);
}

async function runAssignmentDeadlineReminders() {
  const now = new Date();
  const windowEnd = new Date(now.getTime() + REMINDER_WINDOW_MS);

  const assignments = await prisma.taskAssignment.findMany({
    where: { status: "ACTIVE", deadlineReminderSent: false, dueDate: { gte: now, lte: windowEnd } },
    select: { id: true, institutionId: true, divisionId: true, title: true, dueDate: true },
  });

  for (const assignment of assignments) {
    try {
      await notifyDivisionStudents(
        assignment.institutionId,
        assignment.divisionId,
        `Assignment due soon: ${assignment.title}`,
        `"${assignment.title}" is due on ${assignment.dueDate!.toLocaleDateString("en-IN")} — submit before then.`,
        "EXAM_REMINDER"
      );
      await prisma.taskAssignment.update({ where: { id: assignment.id }, data: { deadlineReminderSent: true } });
    } catch (err) {
      console.error(`[Deadline Reminder Cron] Assignment reminder failed for ${assignment.id}:`, err);
    }
  }

  console.log(`[Deadline Reminder Cron] Sent ${assignments.length} assignment deadline reminder(s)`);
}

export function startDeadlineReminderCron() {
  // Hourly — catches a deadline the moment it enters the 24h window, without
  // needing a precise once-a-day slot like the trial/billing crons.
  cron.schedule("0 * * * *", async () => {
    console.log(`[Deadline Reminder Cron] Running at ${new Date().toISOString()}`);
    try {
      await runTestDeadlineReminders();
      await runAssignmentDeadlineReminders();
      await recordCronRun("task-deadline-reminders", true);
    } catch (err) {
      console.error("[Deadline Reminder Cron] Run failed:", err);
      await recordCronRun("task-deadline-reminders", false, err instanceof Error ? err.message : "Unknown error");
    }
  });

  console.log("[Deadline Reminder Cron] Scheduled — hourly, 24h-ahead window");
}
