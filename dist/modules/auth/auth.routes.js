"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_controller_1 = require("./auth.controller");
const router = (0, express_1.Router)();
router.get("/invite/verify", auth_controller_1.verifyInvite);
router.post("/invite/accept", auth_controller_1.acceptInvite);
router.post("/login", auth_controller_1.login);
exports.default = router;
