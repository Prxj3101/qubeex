// src/modules/quiz/quiz.routes.ts — public routes, no auth required
import { Router } from "express";
import { getQuizInfo, startQuiz, submitQuiz, getAttemptResult } from "../teacher/tasks.controller";

const router = Router();

router.get("/attempt/:id", getAttemptResult);
router.get("/:testLink", getQuizInfo);
router.post("/:testLink/start", startQuiz);
router.post("/:testLink/submit", submitQuiz);

export default router;
