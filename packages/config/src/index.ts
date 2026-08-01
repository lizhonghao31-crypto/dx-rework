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
    DINGTALK_CORP_ID: z.string().min(1),
    DINGTALK_H5_APP_KEY: z.string().min(1),
    DINGTALK_H5_APP_SECRET: z.string().min(1),
    DINGTALK_WEB_CLIENT_ID: z.string().min(1),
    DINGTALK_WEB_CLIENT_SECRET: z.string().min(1),
    DINGTALK_QR_REDIRECT_URI: z.string().url(),
    APP_BASE_PATH: z.string().regex(/^\/(?!\/)[^?#\\]*$/).refine((value) => !value.includes("//"), "must not contain empty path segments").default("/"),
    SESSION_SECRET: z.string().min(32),
    SESSION_TTL_SECONDS: z.coerce.number().int().min(300).max(86400).default(28800),
    ORGANIZATION_FRESHNESS_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),
  })
  .superRefine((environment, context) => {
    if (environment.NODE_ENV !== "production") return;
    if (!/^[0-9a-f]{40}$/i.test(environment.GIT_SHA)) {
      context.addIssue({ code: "custom", path: ["GIT_SHA"], message: "production requires a full 40-character Git SHA" });
    }
    if (Number.isNaN(Date.parse(environment.BUILD_TIME))) {
      context.addIssue({ code: "custom", path: ["BUILD_TIME"], message: "production requires an ISO build timestamp" });
    }
    for (const key of ["DINGTALK_CORP_ID", "DINGTALK_H5_APP_KEY", "DINGTALK_H5_APP_SECRET", "DINGTALK_WEB_CLIENT_ID", "DINGTALK_WEB_CLIENT_SECRET", "DINGTALK_QR_REDIRECT_URI", "SESSION_SECRET"] as const) {
      if (environment[key].toLowerCase().includes("replace")) context.addIssue({ code: "custom", path: [key], message: "production rejects placeholder values" });
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
  dingtalk: Readonly<{ corpId: string; h5AppKey: string; h5AppSecret: string; webClientId: string; webClientSecret: string; qrRedirectUri: string }>;
  appBasePath: string;
  sessionSecret: string;
  sessionTtlSeconds: number;
  organizationFreshnessSeconds: number;
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
    dingtalk: { corpId: result.data.DINGTALK_CORP_ID, h5AppKey: result.data.DINGTALK_H5_APP_KEY, h5AppSecret: result.data.DINGTALK_H5_APP_SECRET, webClientId: result.data.DINGTALK_WEB_CLIENT_ID, webClientSecret: result.data.DINGTALK_WEB_CLIENT_SECRET, qrRedirectUri: result.data.DINGTALK_QR_REDIRECT_URI },
    appBasePath: result.data.APP_BASE_PATH.endsWith("/") ? result.data.APP_BASE_PATH : `${result.data.APP_BASE_PATH}/`,
    sessionSecret: result.data.SESSION_SECRET,
    sessionTtlSeconds: result.data.SESSION_TTL_SECONDS,
    organizationFreshnessSeconds: result.data.ORGANIZATION_FRESHNESS_SECONDS,
  });
}
