import { Response, NextFunction } from "express";
import { AuthRequest } from "../../middlewares/auth.middleware";
import { prisma } from "../../utils/prisma";
import { checkInstitutionAccess } from "../../utils/authorization";
import { uploadImageToSupabase } from "../../services/storage.service";
import { logAudit } from "../../services/audit.service";
import { NotFoundError, BadRequestError } from "../../utils/errors";
import { z } from "zod";

const updateInstitutionSchema = z.object({
  name: z.string().min(2).max(200).trim().optional(),
  email: z.string().email().max(255).toLowerCase().trim().optional(),
  phone: z.string().max(20).trim().optional().nullable(),
});

export const getMyInstitution = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const user = req.user!;

    if (!user.institutionId) {
      throw new BadRequestError("No institution associated with this account");
    }

    checkInstitutionAccess(user, user.institutionId);

    const institution = await prisma.institution.findUnique({
      where: { id: user.institutionId },
      include: {
        users: {
          omit: { password: true },
        },
        subscription: true,
      },
    });

    if (!institution) {
      throw new NotFoundError("Institution not found");
    }

    res.json({ success: true, data: institution });
  } catch (error) {
    next(error);
  }
};

export const updateMyInstitution = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const user = req.user!;

    if (!user.institutionId) {
      throw new BadRequestError("No institution associated with this account");
    }

    checkInstitutionAccess(user, user.institutionId);

    const data = updateInstitutionSchema.parse(req.body);
    const institution = await prisma.institution.update({
      where: { id: user.institutionId },
      data,
    });

    await logAudit("INSTITUTION_UPDATED", {
      userId: user.userId,
      actorRole: user.role,
      institutionId: institution.id,
      details: `${institution.name} details updated`,
      metadata: { email: institution.email },
    });

    res.json({ success: true, data: institution });
  } catch (error) {
    next(error);
  }
};

export const uploadMyInstitutionLogo = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const user = req.user!;

    if (!user.institutionId) {
      throw new BadRequestError("No institution associated with this account");
    }

    checkInstitutionAccess(user, user.institutionId);

    const file = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const uploaded = await uploadImageToSupabase(file, {
      contentType: req.headers["content-type"] ?? "",
      folder: "institutions/logos",
      ownerId: user.institutionId,
    });

    const institution = await prisma.institution.update({
      where: { id: user.institutionId },
      data: { logoUrl: uploaded.publicUrl },
    });

    await logAudit("INSTITUTION_LOGO_UPDATED", {
      userId: user.userId,
      actorRole: user.role,
      institutionId: institution.id,
      details: `${institution.name} logo updated`,
      metadata: { path: uploaded.path, logoUrl: uploaded.publicUrl },
    });

    res.json({
      success: true,
      data: { logoUrl: uploaded.publicUrl, path: uploaded.path, institution },
    });
  } catch (error) {
    next(error);
  }
};
