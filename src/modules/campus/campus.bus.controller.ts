import { Response, NextFunction } from "express";
import { z } from "zod";
import { AuthRequest } from "../../middlewares/auth.middleware";
import { academicDb } from "../../utils/academicContext";
import { BadRequestError, NotFoundError } from "../../utils/errors";
import { assignStudentBus, BUS_REQUEST_KEY, removeStudentBus, updateStudentBusFee } from "../../services/studentBus.service";

// Fee card ↔ Transport: the fee card's Bus field picks a real bus + stop.
// All writes go through studentBus.service so the Transport page, the map and
// the parent app see the same thing.

function requireInstitution(req: AuthRequest) {
  const { institutionId } = req.user!;
  if (!institutionId) throw new BadRequestError("No institution");
  return institutionId;
}

async function studentInDivision(req: AuthRequest) {
  const institutionId = requireInstitution(req);
  const divisionId = req.params.divisionId as string;
  const studentId = z.string().uuid().parse(req.params.studentId);
  const found = await academicDb().student.count({ where: { id: studentId, divisionId, institutionId } });
  if (!found) throw new NotFoundError("Student not found in this division");
  return { institutionId, studentId };
}

// GET /admin/campus/divisions/:divisionId/transport
// The school's buses with their stops (for the dropdowns) and who in this
// division rides which bus.
export const getDivisionTransport = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = requireInstitution(req);
    const divisionId = req.params.divisionId as string;
    const db = academicDb();
    const [buses, rides] = await Promise.all([
      db.transportBus.findMany({
        where: { institutionId },
        orderBy: { name: "asc" },
        select: {
          id: true, name: true, morningShift: true, afternoonShift: true,
          route: { select: { id: true, name: true, stops: { orderBy: { sequence: "asc" }, select: { id: true, name: true, monthlyFee: true } } } },
        },
      }),
      db.studentTransport.findMany({
        where: { institutionId, student: { divisionId } },
        select: { studentId: true, busId: true, stopId: true, shift: true },
      }),
    ]);
    res.json({ success: true, data: { buses, rides } });
  } catch (err) { next(err); }
};

const busSchema = z.object({
  enabled: z.boolean(),
  busId: z.string().uuid().optional(),
  stopId: z.string().uuid().nullable().optional(),
  shift: z.enum(["MORNING", "AFTERNOON"]).optional(),
}).strict();

// PUT /admin/campus/divisions/:divisionId/students/:studentId/bus
// Turn bus on (with bus + stop) or off. Returns the student's updated fields.
export const setStudentBus = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId, studentId } = await studentInDivision(req);
    const body = busSchema.parse(req.body);
    let fields;
    if (body.enabled && !body.busId) {
      // "Decide later": needs the bus, but which one isn't known yet → Transport → Waiting list
      const student = await academicDb().student.findFirst({ where: { id: studentId, institutionId }, select: { extraDetailFields: true } });
      fields = { ...((student?.extraDetailFields as Record<string, string> | null) ?? {}), [BUS_REQUEST_KEY]: "FEE_CARD" };
      await academicDb().student.update({ where: { id: studentId }, data: { extraDetailFields: fields } });
    } else if (body.enabled && body.busId) {
      fields = await assignStudentBus(institutionId, studentId, { busId: body.busId, stopId: body.stopId ?? null, shift: body.shift });
    } else {
      fields = await removeStudentBus(institutionId, studentId);
    }
    res.json({ success: true, data: { extraDetailFields: fields } });
  } catch (err) { next(err); }
};

const feeSchema = z.object({
  fee: z.number().int().min(0).max(100000).nullable().optional(),
  months: z.array(z.string().min(1)).max(24).optional(),
}).strict();

// PATCH /admin/campus/divisions/:divisionId/students/:studentId/bus-fee
// Change the bus fee amount and/or which months it applies to. Months already
// due or paid keep the amount they had.
export const setStudentBusFee = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId, studentId } = await studentInDivision(req);
    const fields = await updateStudentBusFee(institutionId, studentId, feeSchema.parse(req.body));
    res.json({ success: true, data: { extraDetailFields: fields } });
  } catch (err) { next(err); }
};
