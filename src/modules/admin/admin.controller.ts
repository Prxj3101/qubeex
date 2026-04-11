import { Response, NextFunction } from "express";
import { AuthRequest } from "../../middlewares/auth.middleware";
import { prisma } from "../../utils/prisma";
import { checkInstitutionAccess } from "../../utils/authorization";
import { NotFoundError, BadRequestError } from "../../utils/errors";

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