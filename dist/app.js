"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const superadmin_routes_1 = __importDefault(require("./modules/superadmin/superadmin.routes"));
const auth_routes_1 = __importDefault(require("./modules/auth/auth.routes"));
const app = (0, express_1.default)();
app.use(express_1.default.json());
app.use("/api/superadmin", superadmin_routes_1.default);
app.use("/api/auth", auth_routes_1.default);
app.get('/', (req, res) => {
    res.send("Server is running...");
});
exports.default = app;
