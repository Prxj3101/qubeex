"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.resendInvite = exports.toggleStatus = exports.updataInstitution = exports.getInstitution = exports.getInstitutions = exports.createInstitution = void 0;
const service = __importStar(require("../superadmin/superadmin.service"));
const superadmin_schema_1 = require("../superadmin/superadmin.schema");
const createInstitution = async (req, res) => {
    try {
        const data = superadmin_schema_1.createInstitutionSchema.parse(req.body);
        const result = await service.createInstitutionService(data);
        res.status(201).json({
            success: true,
            data: result,
        });
    }
    catch (error) {
        res.status(400).json({
            success: false,
            message: error.message,
        });
    }
};
exports.createInstitution = createInstitution;
const getInstitutions = async (_req, res) => {
    const data = await service.getInstitution();
    res.json({
        success: true,
        data,
    });
};
exports.getInstitutions = getInstitutions;
const getInstitution = async (req, res) => {
    try {
        const data = await service.getInstitutionById(req.params.id);
        res.json({
            success: true,
            data
        });
    }
    catch (e) {
        res.status(404).json({
            success: false,
            message: e.message,
        });
    }
};
exports.getInstitution = getInstitution;
const updataInstitution = async (req, res) => {
    try {
        const data = superadmin_schema_1.updateInstitutionSchema.parse(req.body);
        const result = await service.updateInstitution(req.params.id, data);
        res.json({
            success: true,
            data: result
        });
    }
    catch (e) {
        res.status(400).json({
            success: false,
            message: e.message,
        });
    }
};
exports.updataInstitution = updataInstitution;
const toggleStatus = async (req, res) => {
    try {
        const { status } = superadmin_schema_1.toggleStatusSchema.parse(req.body);
        const result = await service.toggleInstitutionStatus(req.params.id, status);
        res.json({
            success: true,
            data: result
        });
    }
    catch (e) {
        res.status(400).json({
            success: false,
            message: e.message
        });
    }
};
exports.toggleStatus = toggleStatus;
const resendInvite = async (req, res) => {
    try {
        const { email } = req.body;
        const result = await service.resendInvite(email);
        res.json({
            success: true,
            data: result
        });
    }
    catch (e) {
        res.status(400).json({
            success: false,
            message: e.message
        });
    }
};
exports.resendInvite = resendInvite;
