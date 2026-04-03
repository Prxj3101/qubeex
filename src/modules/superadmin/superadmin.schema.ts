import { z } from 'zod';

export const createInstitutionSchema = z.object({
    name:z.string().min(2),
    email:z.string().email("Invalid email address").toLowerCase().trim(),
    type:z.enum(["SCHOOL","COLLEGE","COACHING"]),
    
    adminName : z.string().min(2),
    adminEmail : z.string().email("Invalid email address").toLowerCase().trim(),
});

export const updateInstitutionSchema = z.object({
    name : z.string().optional(),
    email:z.string().email().optional(),
    type: z.enum(["SCHOOL","COLLEGE","COACHING"]).optional(),
})

export const toggleStatusSchema = z.object({
    status : z.enum(["ACTIVE","SUSPENDED"])
})