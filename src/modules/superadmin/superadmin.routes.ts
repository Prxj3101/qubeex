import { Router } from "express";
import {
    createInstitution,
    updataInstitution,
    getInstitution,
    getInstitutions,
    toggleStatus,
    resendInvite,
} from "./superadmin.controller";
import { authMiddleware } from "../../middlewares/auth.middleware";

const router = Router();

router.post("/institutions", authMiddleware(["SUPER_ADMIN"]), createInstitution);
router.get("/institutions", authMiddleware(["SUPER_ADMIN"]), getInstitutions);
router.get("/institutions/:id",authMiddleware(["SUPER_ADMIN"]), getInstitution);
router.put("/institutions/:id",authMiddleware(["SUPER_ADMIN"]), updataInstitution);
router.patch("/institutions/:id/status",authMiddleware(["SUPER_ADMIN"]), toggleStatus);
router.post("/institutions/:id/resend-invite",authMiddleware(["SUPER_ADMIN"]), resendInvite);

export default router;