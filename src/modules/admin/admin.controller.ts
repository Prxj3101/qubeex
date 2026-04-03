import { Response } from "express";
import { AuthRequest } from "../../middlewares/auth.middleware";
import { prisma } from "../../utils/prisma";

export const getMyInstitution = async (req: AuthRequest, res: Response) => {
  const institution = await prisma.institution.findUnique({
    where: { id: req.user!.institutionId },
  });

  res.json({ success: true, data: institution });
};