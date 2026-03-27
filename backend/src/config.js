import dotenv from "dotenv";

dotenv.config();

export const config = {
  port: Number(process.env.PORT || 4000),
  nodeEnv: process.env.NODE_ENV || "development",
  databaseUrl:
    process.env.DATABASE_URL ||
    "postgresql://chatuser:chatpassword@localhost:5432/chatdb",
  jwtSecret: process.env.JWT_SECRET || "dev_secret_key",
};
