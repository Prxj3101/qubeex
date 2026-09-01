// src/services/ptmNote.service.ts
//
// Parent-Teacher Meeting notes: short discussion points a teacher/admin logs
// against a student, live from the app's "Parent Mode" screen (a toggle the
// student's own account switches into during a PTM — no separate parent
// login exists). The parent taps "Discussed & Acknowledged" at the end of
// the meeting as a closure marker for the teacher's record.
import { academicDb } from "../utils/academicContext";
import { resolveUsers } from "./userLookup.service";

export interface PTMNoteDTO {
  id: string;
  studentId: string;
  note: string;
  createdByName: string;
  createdByRole: string;
  createdAt: string;
  acknowledgedAt: string | null;
}

type PTMNoteRow = {
  id: string;
  studentId: string;
  note: string;
  createdByUserId: string;
  createdByName: string | null;
  createdByRole: string;
  createdAt: Date;
  acknowledgedAt: Date | null;
};

function toDTO(row: PTMNoteRow, fallbackName?: string): PTMNoteDTO {
  return {
    id: row.id,
    studentId: row.studentId,
    note: row.note,
    createdByName: row.createdByName ?? fallbackName ?? "Teacher",
    createdByRole: row.createdByRole,
    createdAt: row.createdAt.toISOString(),
    acknowledgedAt: row.acknowledgedAt ? row.acknowledgedAt.toISOString() : null,
  };
}

/** Creates a PTM note. Denormalizes the author's display name at write time
 * (rather than joining at read time) since Student/PTMNote may live in a
 * tenant DB with no User table to join against. */
export async function createPTMNote(params: {
  institutionId: string;
  studentId: string;
  createdByUserId: string;
  createdByRole: "Faculty" | "Admin";
  note: string;
}): Promise<PTMNoteDTO> {
  const { institutionId, studentId, createdByUserId, createdByRole, note } = params;

  const users = await resolveUsers([createdByUserId], { id: true, name: true });
  const createdByName = users.get(createdByUserId)?.name ?? null;

  const row = await academicDb().pTMNote.create({
    data: { institutionId, studentId, createdByUserId, createdByRole, createdByName, note },
  });

  return toDTO(row);
}

/** Most recent PTM notes for a student, newest first. Used both for the
 * teacher-facing history and the student app's Parent Mode screen. */
export async function listPTMNotes(studentId: string, institutionId: string, limit = 10): Promise<PTMNoteDTO[]> {
  const rows = await academicDb().pTMNote.findMany({
    where: { studentId, institutionId },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return rows.map((r) => toDTO(r));
}

/** Edits a previously-saved note's text. Restricted to the teacher/admin who
 * originally created it, mirroring editStudentRemark's authorization pattern. */
export async function editPTMNote(params: {
  noteId: string;
  studentId: string;
  institutionId: string;
  viewerUserId: string;
  note: string;
}): Promise<PTMNoteDTO> {
  const { noteId, studentId, institutionId, viewerUserId, note } = params;

  const existing = await academicDb().pTMNote.findFirst({
    where: { id: noteId, studentId, institutionId },
    select: { createdByUserId: true },
  });
  if (!existing) throw { status: 404, message: "PTM note not found" };
  if (existing.createdByUserId !== viewerUserId) {
    throw { status: 403, message: "Only the person who added this note can edit it" };
  }

  const row = await academicDb().pTMNote.update({
    where: { id: noteId },
    data: { note },
  });

  return toDTO(row);
}

/** Marks a note acknowledged — tapped by the parent on the student's own
 * device at the end of the meeting. Not identity verification, just a
 * meeting-closure marker for the teacher's record. */
export async function acknowledgePTMNote(params: {
  noteId: string;
  studentId: string;
  institutionId: string;
}): Promise<PTMNoteDTO> {
  const { noteId, studentId, institutionId } = params;

  const existing = await academicDb().pTMNote.findFirst({
    where: { id: noteId, studentId, institutionId },
  });
  if (!existing) throw { status: 404, message: "PTM note not found" };

  const row = await academicDb().pTMNote.update({
    where: { id: noteId },
    data: { acknowledgedAt: new Date() },
  });

  return toDTO(row);
}
