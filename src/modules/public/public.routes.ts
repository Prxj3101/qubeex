import { Router } from "express";
import { demoRequestLimiter } from "../../middlewares/rateLimiter.middleware";
import { submitDemoRequest } from "./demoRequest.controller";

const router = Router();

router.post("/demo-requests", demoRequestLimiter, submitDemoRequest);

export default router;
