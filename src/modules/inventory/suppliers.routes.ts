import { Router, Response, NextFunction } from "express";
import { z } from "zod";
import { AuthRequest } from "../../middlewares/auth.middleware";
import { academicDb } from "../../utils/academicContext";
import { BadRequestError, ConflictError, NotFoundError } from "../../utils/errors";

const router = Router();
const schema = z.object({
  name: z.string().trim().min(1).max(80).transform(value => value.replace(/\s+/g, " ")),
  contactPerson: z.string().trim().max(80).default(""),
  phone: z.string().trim().max(32).default("").refine(value => !value || (/^\+?[\d ()-]+$/.test(value) && value.replace(/\D/g, "").length >= 7 && value.replace(/\D/g, "").length <= 15), "Enter a valid phone number"),
  email: z.string().trim().max(254).pipe(z.union([z.email("Enter a valid email address"), z.literal("")])).transform(value => value.toLowerCase()).default(""),
  address: z.string().trim().max(300).default(""),
}).strict();
const idSchema = z.string().uuid();
const institution = (req: AuthRequest) => {
  if (!req.user?.institutionId) throw new BadRequestError("No institution associated with this account");
  return req.user.institutionId;
};
const handleError = (err: unknown, next: NextFunction) => {
  const code = (err as { code?: string })?.code;
  if (code === "P2002") return next(new ConflictError("A supplier with this name already exists"));
  if (code === "P2003") return next(new ConflictError("This supplier is in use and cannot be deleted"));
  next(err);
};
const select = { id: true, name: true, contactPerson: true, phone: true, email: true, address: true };

router.get("/suppliers", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const data = await academicDb().inventorySupplier.findMany({ where: { institutionId: institution(req) }, orderBy: { name: "asc" }, select });
    res.json({ success: true, data });
  } catch (err) { handleError(err, next); }
});
router.post("/suppliers", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) throw new BadRequestError(parsed.error.issues[0]?.message || 'Invalid supplier details');
    const input = parsed.data;
    const data = await academicDb().inventorySupplier.create({ data: { ...input, nameKey: input.name.toLowerCase(), institutionId: institution(req) }, select });
    res.status(201).json({ success: true, data });
  } catch (err) { handleError(err, next); }
});
router.patch("/suppliers/:id", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = idSchema.parse(req.params.id);
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) throw new BadRequestError(parsed.error.issues[0]?.message || 'Invalid supplier details');
    const input = parsed.data;
    const result = await academicDb().inventorySupplier.updateMany({ where: { id, institutionId: institution(req) }, data: { ...input, nameKey: input.name.toLowerCase() } });
    if (!result.count) throw new NotFoundError("Supplier not found");
    res.json({ success: true, data: { id, ...input } });
  } catch (err) { handleError(err, next); }
});
router.delete("/suppliers/:id", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = idSchema.parse(req.params.id);
    const result = await academicDb().inventorySupplier.deleteMany({ where: { id, institutionId: institution(req) } });
    if (!result.count) throw new NotFoundError("Supplier not found");
    res.json({ success: true });
  } catch (err) { handleError(err, next); }
});
export default router;
