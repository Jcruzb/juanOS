import express from "express";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { pinoHttp } from "pino-http";
import { ZodError } from "zod";
import { createAuthRouter, requireSession } from "./auth.js";
import { createProjectsRouter } from "./projects.js";
import { createFilesRouter } from "./files.js";
import { createGitRouter } from "./git.js";
import { createDeploymentsRouter } from "./deployments.js";
import { createOperationsRouter } from "./operations.js";
import { createEnvironmentsRouter } from "./environments.js";
import { createImportsRouter } from "./imports.js";
import { createOperationalLogsRouter } from "./operational-logs.js";

export function createApp({ db, config }) {
  const app = express();
  app.locals.config = config;
  if (config.TRUST_PROXY === "1") app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false
    })
  );
  app.use(pinoHttp({ redact: ["req.headers.cookie", "req.headers.authorization", "req.body.password"] }));
  app.use(express.json({ limit: "256kb" }));
  app.use(cookieParser());

  const loginLimiter = rateLimit({
    windowMs: 15 * 60_000,
    limit: 20,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: { code: "RATE_LIMITED", message: "Demasiados intentos. Inténtalo más tarde." } }
  });

  app.get("/api/health", async (_request, response, next) => {
    try {
      await db.query("SELECT 1");
      response.json({ status: "ok" });
    } catch (error) {
      next(error);
    }
  });
  app.use("/api/auth", createAuthRouter({ express, db, config, loginLimiter }));
  app.use("/api/projects", requireSession(db, config), createImportsRouter({ express, db, config }));
  app.use("/api/projects", requireSession(db, config), createProjectsRouter({ express, db, config }));
  app.use(
    "/api/projects/:projectId/logs",
    requireSession(db, config),
    createOperationalLogsRouter({ express, db })
  );
  app.use(
    "/api/projects/:projectId/environments",
    requireSession(db, config),
    createEnvironmentsRouter({ express, db })
  );
  app.use("/api/projects/:projectId/files", requireSession(db, config), createFilesRouter({ express, db }));
  app.use("/api/projects/:projectId/git", requireSession(db, config), createGitRouter({ express, db }));
  app.use("/api/deployments", requireSession(db, config), createDeploymentsRouter({ express, db }));
  app.use("/api", requireSession(db, config), createOperationsRouter({ express, db }));

  app.use((_request, response) => {
    response.status(404).json({ error: { code: "NOT_FOUND", message: "Ruta no encontrada" } });
  });
  app.use((error, request, response, next) => {
    void next;
    if (error instanceof ZodError) {
      return response.status(400).json({
        error: { code: "VALIDATION_ERROR", message: "Datos no válidos", details: error.issues }
      });
    }
    if (error?.code === "23505") {
      return response.status(409).json({ error: { code: "CONFLICT", message: "El recurso ya existe" } });
    }
    if (error?.status) {
      return response.status(error.status).json({
        error: {
          code: error.code || "OPERATION_FAILED",
          message: error.message,
          details: error.details || error.issues
        }
      });
    }
    request.log?.error({ err: error, requestId: request.id }, "request failed");
    response.status(500).json({
      error: { code: "INTERNAL_ERROR", message: "Error interno", requestId: request.id }
    });
  });
  return app;
}
