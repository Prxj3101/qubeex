import { Router, Response, NextFunction } from "express";
import { z } from "zod";
import { AuthRequest } from "../../middlewares/auth.middleware";
import { academicDb } from "../../utils/academicContext";
import { BadRequestError, ConflictError, NotFoundError } from "../../utils/errors";

const router = Router();
const schema = z.object({
  name: z.string().trim().min(1).max(80).transform(value => value.replace(/\s+/g, " ")),
  description: z.string().trim().max(300).default(""),
}).strict();
const idSchema = z.string().uuid();
const institution = (req: AuthRequest) => {
  if (!req.user?.institutionId) throw new BadRequestError("No institution associated with this account");
  return req.user.institutionId;
};
const handleError = (err: unknown, next: NextFunction) => {
  const code = (err as { code?: string })?.code;
  if (code === "P2002") return next(new ConflictError("A location with this name already exists"));
  if (code === "P2003") return next(new ConflictError("This location is in use and cannot be deleted"));
  next(err);
};
const select = { id: true, name: true, description: true };

router.get("/locations", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const data = await academicDb().inventoryLocation.findMany({ where: { institutionId: institution(req) }, orderBy: { name: "asc" }, select });
    res.json({ success: true, data });
  } catch (err) { handleError(err, next); }
});
router.post("/locations", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const input = schema.parse(req.body);
    const data = await academicDb().inventoryLocation.create({ data: { ...input, nameKey: input.name.toLowerCase(), institutionId: institution(req) }, select });
    res.status(201).json({ success: true, data });
  } catch (err) { handleError(err, next); }
});
router.patch("/locations/:id", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = idSchema.parse(req.params.id);
    const input = schema.parse(req.body);
    const result = await academicDb().inventoryLocation.updateMany({ where: { id, institutionId: institution(req) }, data: { ...input, nameKey: input.name.toLowerCase() } });
    if (!result.count) throw new NotFoundError("Location not found");
    res.json({ success: true, data: { id, ...input } });
  } catch (err) { handleError(err, next); }
});
router.delete("/locations/:id", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = idSchema.parse(req.params.id);
    const result = await academicDb().inventoryLocation.deleteMany({ where: { id, institutionId: institution(req) } });
    if (!result.count) throw new NotFoundError("Location not found");
    res.json({ success: true });
  } catch (err) { handleError(err, next); }
});
export default router;
