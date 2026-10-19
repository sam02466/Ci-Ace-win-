import type { FastifyInstance } from "fastify";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { prisma } from "../database/prisma.js";
import { AppError } from "../utils/errors.js";
import { sendOtp, verifyOtp } from "./auth/auth.service.js";

const identifierSchema = z.string().trim().min(3).max(320).refine(v => v.includes("@") || /^[+0-9() -]{7,20}$/.test(v), "Use a valid email or phone number");
const passwordSchema = z.string().min(10).max(128).regex(/[A-Za-z]/).regex(/[0-9]/);
const safeUser = (u: any) => ({ id:u.id, email:u.email, phone:u.phone, status:u.status, displayName:u.displayName, dateOfBirth:u.dateOfBirth, createdAt:u.createdAt, notificationPreferences:u.notificationPreferences });

export async function accountRoutes(app: FastifyInstance) {
  app.patch("/api/users/me", { preHandler:[app.authenticate] }, async (req) => {
    const body = z.object({ displayName:z.string().trim().min(1).max(80).optional(), dateOfBirth:z.coerce.date().optional(), notificationPreferences:z.record(z.string(), z.boolean()).optional() }).strict().refine(v => Object.keys(v).length > 0, "At least one field is required").parse(req.body);
    if (body.dateOfBirth && body.dateOfBirth > new Date()) throw new AppError("INVALID_DATE_OF_BIRTH", "Date of birth cannot be in the future", 400);
    const user = await prisma.user.update({ where:{id:req.user.sub}, data:body });
    return { success:true, user:safeUser(user) };
  });

  app.post("/api/auth/password/reset/request", async (req) => {
    const body=z.object({identifier:identifierSchema}).parse(req.body);
    // Uses the existing rate-limited OTP mechanism; delivery provider is configured separately.
    await sendOtp(body.identifier);
    return { success:true, message:"If the account can be verified, a reset code has been requested." };
  });

  app.post("/api/auth/password/reset/confirm", async (req) => {
    const body=z.object({identifier:identifierSchema, code:z.string().regex(/^\d{6}$/), newPassword:passwordSchema}).parse(req.body);
    const user=await verifyOtp(body.identifier, body.code);
    const passwordHash=await bcrypt.hash(body.newPassword, 12);
    await prisma.user.update({where:{id:user.id},data:{passwordHash}});
    return {success:true,message:"Password updated. You can now sign in."};
  });

  app.post("/api/auth/password/login", async (req, reply) => {
    const body=z.object({identifier:identifierSchema,password:z.string().min(1).max(128)}).parse(req.body);
    const normalized=body.identifier.trim().toLowerCase();
    const user=normalized.includes("@") ? await prisma.user.findUnique({where:{email:normalized}}) : await prisma.user.findUnique({where:{phone:normalized}});
    if (!user?.passwordHash || !(await bcrypt.compare(body.password,user.passwordHash))) throw new AppError("INVALID_CREDENTIALS","Invalid credentials",401);
    if (user.status !== "ACTIVE") throw new AppError("ACCOUNT_UNAVAILABLE","Account is not active",403);
    const token=await reply.jwtSign({sub:user.id});
    return {success:true,token,user:safeUser(user)};
  });

  app.get("/api/notifications", {preHandler:[app.authenticate]}, async req => {
    const q=z.object({unreadOnly:z.coerce.boolean().default(false),limit:z.coerce.number().int().min(1).max(100).default(50)}).parse(req.query);
    const items=await prisma.notification.findMany({where:{userId:req.user.sub,...(q.unreadOnly?{readAt:null}:{})},orderBy:{createdAt:"desc"},take:q.limit});
    return {success:true,notifications:items,unreadCount:await prisma.notification.count({where:{userId:req.user.sub,readAt:null}})};
  });

  app.patch("/api/notifications/:id/read", {preHandler:[app.authenticate]}, async (req) => {
    const {id}=z.object({id:z.string().uuid()}).parse(req.params);
    const result=await prisma.notification.updateMany({where:{id,userId:req.user.sub,readAt:null},data:{readAt:new Date()}});
    if (!result.count) { const existing=await prisma.notification.findFirst({where:{id,userId:req.user.sub}}); if(!existing) throw new AppError("NOTIFICATION_NOT_FOUND","Notification not found",404); }
    return {success:true};
  });

  app.post("/api/notifications/read-all", {preHandler:[app.authenticate]}, async req => {
    const result=await prisma.notification.updateMany({where:{userId:req.user.sub,readAt:null},data:{readAt:new Date()}});
    return {success:true,updated:result.count};
  });

  // Payment movement, bonus issuance, and agent commissions are deliberately not exposed
  // as pretend-success APIs. They require approved payment providers, audit controls,
  // eligibility/compliance rules, and privileged admin workflows before activation.
  app.get("/api/capabilities", async () => ({success:true,capabilities:{profile:true,passwordReset:true,notifications:true,paymentIntents:false,depositPayout:false,bonuses:false,agentCommissions:false},disabledReason:"Financial movement and incentive modules require provider, compliance, and admin controls."}));
}
