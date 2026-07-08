// src/services/remark.service.ts
import { prisma } from "../utils/prisma";
import { CreateRemarkInput } from "./remark.schema";

export interface StudentRemarkDTO {
  id: string;
  type: "yellow" | "red";
  category: string;
  title: string;
  detail: string;
  date: string;
  subject?: string;
  reportedBy: string;
  role: string;
  status: "active" | "resolved" | "appealed";
  actionTaken?: string;
}

function formatRemarkDate(d: Date): string {
  const day = d.getDate();
  const month = d.toLocaleString("en-US", { month: "short" });
  const year = d.getFullYear();
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
  return `${day} ${month} ${year}, ${time}`;
}

function toDTO(row: {
  id: string;
  type: "YELLOW" | "RED";
  category: string;
  title: string;
  detail: string;
  createdAt: Date;
  subject: string | null;
  status: "ACTIVE" | "RESOLVED" | "APPEALED";
  actionTaken: string | null;
  reportedByRole: string;
  reportedByUser: { name: string | null };
}): StudentRemarkDTO {
  return {
    id: row.id,
    type: row.type === "YELLOW" ? "yellow" : "red",
    category: row.category,
    title: row.title,
    detail: row.detail,
    date: formatRemarkDate(row.createdAt),
    subject: row.subject ?? undefined,
    reportedBy: row.reportedByUser.name ?? "Unknown",
    role: row.reportedByRole,
    status: row.status.toLowerCase() as "active" | "resolved" | "appealed",
    actionTaken: row.actionTaken ?? undefined,
  };
}

export async function createStudentRemark(params: {
  institutionId: string;
  studentId: string;
  reportedByUserId: string;
  reportedByRole: "Faculty" | "Admin";
  data: CreateRemarkInput;
}): Promise<StudentRemarkDTO> {
  const { institutionId, studentId, reportedByUserId, reportedByRole, data } = params;

  const row = await prisma.studentRemark.create({
    data: {
      institutionId,
      studentId,
      reportedByUserId,
      reportedByRole,
      type: data.type === "yellow" ? "YELLOW" : "RED",
      category: data.category,
      title: data.title,
      detail: data.detail,
      subject: data.subject,
      actionTaken: data.actionTaken,
    },
    include: { reportedByUser: { select: { name: true } } },
  });

  return toDTO(row);
}

export async function listStudentRemarks(
  studentId: string,
  institutionId: string
): Promise<StudentRemarkDTO[]> {
  const rows = await prisma.studentRemark.findMany({
    where: { studentId, institutionId },
    orderBy: { createdAt: "desc" },
    include: { reportedByUser: { select: { name: true } } },
  });

  return rows.map(toDTO);
}
