import { withSetupOrder } from "./setup-order";
import { Router, Response, NextFunction } from "express";
import { z } from "zod";
import { AuthRequest } from "../../middlewares/auth.middleware";
import { academicDb } from "../../utils/academicContext";
import { BadRequestError, ConflictError, NotFoundError } from "../../utils/errors";
import { ensureDefaultSetup } from "./inventory-defaults";

const router = Router();
const schema = z.object({
  name: z.string().trim().min(1).max(80).transform(value => value.replace(/\s+/g, " ")),
  abbreviation: z.string().trim().max(16).default(""),
}).strict();
const idSchema = z.string().uuid();
const institution = (req: AuthRequest) => {
  if (!req.user?.institutionId) throw new BadRequestError("No institution associated with this account");
  return req.user.institutionId;
};
const handleError = (err: unknown, next: NextFunction) => {
  const code = (err as { code?: string })?.code;
  if (code === "P2002") return next(new ConflictError("A unit with this name already exists"));
  if (code === "P2003") return next(new ConflictError("This unit is in use and cannot be deleted"));
  next(err);
};
const select = { id: true, name: true, abbreviation: true, isDefault: true };

router.get("/units", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    await ensureDefaultSetup("units", institution(req));
    const data = await academicDb().inventoryUnit.findMany({ where: { institutionId: institution(req) }, orderBy: { name: "asc" }, select });
    res.json({ success: true, ...await withSetupOrder("units", institution(req), data) });
  } catch (err) { handleError(err, next); }
});
router.post("/units", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const input = schema.parse(req.body);
    const data = await academicDb().inventoryUnit.create({ data: { ...input, nameKey: input.name.toLowerCase(), institutionId: institution(req) }, select });
    res.status(201).json({ success: true, data });
  } catch (err) { handleError(err, next); }
});
router.patch("/units/:id", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = idSchema.parse(req.params.id);
    const input = schema.parse(req.body);
    const result = await academicDb().inventoryUnit.updateMany({ where: { id, institutionId: institution(req) }, data: { ...input, nameKey: input.name.toLowerCase() } });
    if (!result.count) throw new NotFoundError("Unit not found");
    const data = await academicDb().inventoryUnit.findFirst({ where: { id, institutionId: institution(req) }, select });
    res.json({ success: true, data });
  } catch (err) { handleError(err, next); }
});
router.delete("/units/:id", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = idSchema.parse(req.params.id);
    if (await academicDb().inventoryUnit.count({ where: { id, institutionId: institution(req), isDefault: true } })) throw new ConflictError("Built-in units cannot be deleted. You can rename them instead.");
    const result = await academicDb().inventoryUnit.deleteMany({ where: { id, institutionId: institution(req), isDefault: false } });
    if (!result.count) throw new NotFoundError("Unit not found");
    res.json({ success: true });
  } catch (err) { handleError(err, next); }
});
export default router;
