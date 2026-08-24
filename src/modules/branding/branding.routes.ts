import { Router } from "express";
import { authMiddleware } from "../../middlewares/auth.middleware";
import { getBranding } from "./branding.controller";

const router = Router();

router.get("/", authMiddleware(), getBranding);

export default router;
