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

const BooleanTextSchema = z.enum(["true", "false"]).default("false");

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
    OWNER_BOOTSTRAP_DINGTALK_USER_ID: z.string().trim().min(1).max(200).optional(),
    OWNER_BOOTSTRAP_SECRET: z.string().min(32).max(1024).optional(),
    TODO_RUNTIME_ENABLED: BooleanTextSchema,
    TODO_RUNTIME_ACTOR_ID: z.string().uuid().optional(),
    TODO_DELIVERY_INTERVAL_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(30_000),
    TODO_TIMING_INTERVAL_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(60_000),
    OSS_REGION: z.string().min(1).optional(),
    OSS_ENDPOINT: z.string().url().optional(),
    OSS_BUCKET: z.string().min(1).optional(),
    OSS_ACCESS_KEY_ID: z.string().min(1).optional(),
    OSS_ACCESS_KEY_SECRET: z.string().min(1).optional(),
    OSS_PRIVATE_PREFIX: z.string()
      .regex(/^[A-Za-z0-9/_-]+$/)
      .refine((value) => !value.startsWith("/") && !value.endsWith("/") && !value.includes("//"), "must not be a root or contain empty path segments")
      .default("dx-rework/private"),
    OSS_SIGNED_URL_TTL_SECONDS: z.coerce.number().int().min(60).max(900).default(300),
    OSS_MAX_UPLOAD_BYTES: z.coerce.number().int().min(1).max(104857600).default(20971520),
  })
  .superRefine((environment, context) => {
    const ossValues = [environment.OSS_REGION, environment.OSS_ENDPOINT, environment.OSS_BUCKET, environment.OSS_ACCESS_KEY_ID, environment.OSS_ACCESS_KEY_SECRET];
    if (ossValues.some(Boolean) && !ossValues.every(Boolean)) context.addIssue({ code: "custom", path: ["OSS_BUCKET"], message: "OSS configuration must be complete or entirely disabled" });

    const bootstrapValues = [environment.OWNER_BOOTSTRAP_DINGTALK_USER_ID, environment.OWNER_BOOTSTRAP_SECRET];
    if (bootstrapValues.some(Boolean) && !bootstrapValues.every(Boolean)) {
      context.addIssue({
        code: "custom",
        path: ["OWNER_BOOTSTRAP_SECRET"],
        message: "owner bootstrap requires both DingTalk userid and secret or neither",
      });
    }

    if (environment.TODO_RUNTIME_ENABLED === "true" && !environment.TODO_RUNTIME_ACTOR_ID) {
      context.addIssue({ code: "custom", path: ["TODO_RUNTIME_ACTOR_ID"], message: "todo runtime requires an authorized actor ID" });
    }
    if (environment.NODE_ENV === "test" && environment.TODO_RUNTIME_ENABLED === "true") {
      context.addIssue({ code: "custom", path: ["TODO_RUNTIME_ENABLED"], message: "test environment cannot enable the real todo runtime" });
    }
    if (environment.NODE_ENV !== "production") return;
    if (environment.OSS_ENDPOINT && new URL(environment.OSS_ENDPOINT).protocol !== "https:") {
      context.addIssue({ code: "custom", path: ["OSS_ENDPOINT"], message: "production requires an HTTPS OSS endpoint" });
    }
    for (const key of ["OSS_ACCESS_KEY_ID", "OSS_ACCESS_KEY_SECRET"] as const) {
      if (environment[key]?.toLowerCase().includes("replace")) {
        context.addIssue({ code: "custom", path: [key], message: "production rejects placeholder values" });
      }
    }
    if (!/^[0-9a-f]{40}$/i.test(environment.GIT_SHA)) {
      context.addIssue({ code: "custom", path: ["GIT_SHA"], message: "production requires a full 40-character Git SHA" });
    }
    if (Number.isNaN(Date.parse(environment.BUILD_TIME))) {
      context.addIssue({ code: "custom", path: ["BUILD_TIME"], message: "production requires an ISO build timestamp" });
    }
    for (const key of ["DINGTALK_CORP_ID", "DINGTALK_H5_APP_KEY", "DINGTALK_H5_APP_SECRET", "DINGTALK_WEB_CLIENT_ID", "DINGTALK_WEB_CLIENT_SECRET", "DINGTALK_QR_REDIRECT_URI", "SESSION_SECRET"] as const) {
      if (environment[key].toLowerCase().includes("replace")) context.addIssue({ code: "custom", path: [key], message: "production rejects placeholder values" });
    }
    for (const key of ["OWNER_BOOTSTRAP_DINGTALK_USER_ID", "OWNER_BOOTSTRAP_SECRET"] as const) {
      if (environment[key]?.toLowerCase().includes("replace")) {
        context.addIssue({ code: "custom", path: [key], message: "production rejects placeholder values" });
      }
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
  ownerBootstrap: Readonly<{
    enabled: boolean;
    dingtalkUserId: string | undefined;
    secret: string | undefined;
  }>;
  todoRuntime: Readonly<{
    enabled: boolean;
    actorId: string | undefined;
    deliveryIntervalMs: number;
    timingIntervalMs: number;
  }>;
  objectStorage: Readonly<{ enabled: boolean; region: string | undefined; endpoint: string | undefined; bucket: string | undefined; accessKeyId: string | undefined; accessKeySecret: string | undefined; privatePrefix: string; signedUrlTtlSeconds: number; maxUploadBytes: number }>;
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
    ownerBootstrap: {
      enabled: Boolean(result.data.OWNER_BOOTSTRAP_DINGTALK_USER_ID && result.data.OWNER_BOOTSTRAP_SECRET),
      dingtalkUserId: result.data.OWNER_BOOTSTRAP_DINGTALK_USER_ID,
      secret: result.data.OWNER_BOOTSTRAP_SECRET,
    },
    todoRuntime: {
      enabled: result.data.TODO_RUNTIME_ENABLED === "true",
      actorId: result.data.TODO_RUNTIME_ACTOR_ID,
      deliveryIntervalMs: result.data.TODO_DELIVERY_INTERVAL_MS,
      timingIntervalMs: result.data.TODO_TIMING_INTERVAL_MS,
    },
    objectStorage: { enabled: Boolean(result.data.OSS_BUCKET), region: result.data.OSS_REGION, endpoint: result.data.OSS_ENDPOINT, bucket: result.data.OSS_BUCKET, accessKeyId: result.data.OSS_ACCESS_KEY_ID, accessKeySecret: result.data.OSS_ACCESS_KEY_SECRET, privatePrefix: result.data.OSS_PRIVATE_PREFIX.replace(/\/$/, ""), signedUrlTtlSeconds: result.data.OSS_SIGNED_URL_TTL_SECONDS, maxUploadBytes: result.data.OSS_MAX_UPLOAD_BYTES },
  });
}
