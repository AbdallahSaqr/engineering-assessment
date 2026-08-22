import { PrismaClient } from "../generated/client/client.js";

const globalDatabase = globalThis as typeof globalThis & {
  assessmentPrisma?: PrismaClient;
};

export const prisma = globalDatabase.assessmentPrisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalDatabase.assessmentPrisma = prisma;
}

export { Prisma, PrismaClient } from "../generated/client/client.js";
