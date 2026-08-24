import { Response, NextFunction } from "express";
import { AuthRequest } from "../../middlewares/auth.middleware";
import { getEffectiveBranding, QUBEEX_DEFAULT_BRANDING } from "../../services/whiteLabel.service";

// Any authenticated role (superadmin included, though superadmin's own UI
// stays QubeEx-branded regardless — this just returns the caller's own
// institution's effective branding).
export const getBranding = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId } = req.user!;
    if (!institutionId) {
      res.json({ success: true, data: { ...QUBEEX_DEFAULT_BRANDING } });
      return;
    }
    const branding = await getEffectiveBranding(institutionId);
    res.json({ success: true, data: branding });
  } catch (error) {
    next(error);
  }
};
