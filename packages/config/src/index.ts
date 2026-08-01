import { z } from "zod";

const PostgreSqlUrlSchema = z.string().min(1).refine(
  (value) => {
    try {
      const protocol = new URL(value).protocol;
      return protocol === "postgres:" || protocol === "postgresql:";
    } catch {
      return false;
    }
  },
  { message: "must be a valid PostgreSQL URL" },
);

const EnvironmentSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    HOST: z.string().min(1).default("127.0.0.1"),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3201),
    DATABASE_URL: PostgreSqlUrlSchema,
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
    GIT_SHA: z.string().min(1).default("local"),
    BUILD_TIME: z.string().min(1).default("local"),
    SERVICE_NAME: z.string().min(1).default("dx-rework-api"),
  })
  .superRefine((environment, context) => {
    if (environment.NODE_ENV !== "production") return;
    if (!/^[0-9a-f]{40}$/i.test(environment.GIT_SHA)) {
      context.addIssue({ code: "custom", path: ["GIT_SHA"], message: "production requires a full 40-character Git SHA" });
    }
    if (Number.isNaN(Date.parse(environment.BUILD_TIME))) {
      context.addIssue({ code: "custom", path: ["BUILD_TIME"], message: "production requires an ISO build timestamp" });
    }
  });

export class ConfigurationError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Invalid application configuration: ${issues.join("; ")}`);
    this.name = "ConfigurationError";
    this.issues = issues;
  }
}

export type AppConfig = Readonly<{
  nodeEnv: "development" | "test" | "production";
  host: string;
  port: number;
  databaseUrl: string;
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
  gitSha: string;
  buildTime: string;
  serviceName: string;
}>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = EnvironmentSchema.safeParse(environment);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join(".") || "environment"}: ${issue.message}`);
    throw new ConfigurationError(issues);
  }

  return Object.freeze({
    nodeEnv: result.data.NODE_ENV,
    host: result.data.HOST,
    port: result.data.PORT,
    databaseUrl: result.data.DATABASE_URL,
    logLevel: result.data.LOG_LEVEL,
    gitSha: result.data.GIT_SHA,
    buildTime: result.data.BUILD_TIME,
    serviceName: result.data.SERVICE_NAME,
  });
}
