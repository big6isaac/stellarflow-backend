import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    // Prisma CLI schema/migration operations use the direct database path;
    // application runtime traffic uses DATABASE_URL through PgBouncer.
    url: process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL || process.env.DB_URL || "postgresql://username:password@localhost:5432/stellarflow",
  },
});
