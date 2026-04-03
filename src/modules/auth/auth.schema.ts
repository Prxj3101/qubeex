import {z} from 'zod';

export const acceptInviteSchema = z.object({
    token : z.string(),
    password : z.string().min(8).max(100).regex(/[A-Z]/, "Must include uppercase").regex(/[0-9]/, "Must include number").regex(/[^A-Za-z0-9]/, "Must include special character"),
});

export const loginSchema = z.object({
    email : z.string().email().toLowerCase().trim(),
    password : z.string().min(8).max(100).regex(/[A-Z]/, "Must include uppercase").regex(/[0-9]/, "Must include number").regex(/[^A-Za-z0-9]/, "Must include special character"),
})