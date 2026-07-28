import test from "node:test";
import assert from "node:assert/strict";
import argon2 from "argon2";
import request from "supertest";
import { createApp } from "../src/app.js";

const config = {
  NODE_ENV: "test",
  PORT: 4000,
  APP_ORIGIN: "http://localhost",
  DATABASE_URL: "unused",
  SESSION_SECRET: "a".repeat(32),
  SESSION_IDLE_MINUTES: 30,
  PROJECTS_ROOT: "/srv/juanos/projects",
  TRUST_PROXY: "0"
};

function fakeDb(passwordHash) {
  const queries = [];
  return {
    queries,
    async transaction(callback) {
      return callback(this);
    },
    async query(sql) {
      queries.push(sql);
      if (sql.includes("FROM users WHERE email")) {
        return {
          rows: [{
            id: "00000000-0000-4000-8000-000000000001",
            email: "admin@example.com",
            password_hash: passwordHash,
            role: "admin",
            is_active: true,
            failed_login_count: 0,
            locked_until: null
          }]
        };
      }
      return { rows: [], rowCount: 1 };
    }
  };
}

test("protege endpoints de proyectos sin sesión", async () => {
  const db = fakeDb("");
  const response = await request(createApp({ db, config })).get("/api/projects");
  assert.equal(response.status, 401);
  assert.equal(response.body.error.code, "UNAUTHENTICATED");
});

test("inicia sesión y entrega cookies seguras para el entorno", async () => {
  const password = "a-long-test-password";
  const db = fakeDb(await argon2.hash(password));
  const response = await request(createApp({ db, config }))
    .post("/api/auth/login")
    .send({ email: "ADMIN@example.com", password });
  assert.equal(response.status, 200);
  assert.equal(response.body.user.email, "admin@example.com");
  assert.ok(response.body.csrfToken);
  const cookies = response.headers["set-cookie"].join(";");
  assert.match(cookies, /juanos_session=/);
  assert.match(cookies, /HttpOnly/);
  assert.match(cookies, /SameSite=Strict/);
  assert.match(cookies, /juanos_csrf=/);
});

test("rechaza contraseña incorrecta sin revelar la cuenta", async () => {
  const db = fakeDb(await argon2.hash("correct-password-123"));
  const response = await request(createApp({ db, config }))
    .post("/api/auth/login")
    .send({ email: "admin@example.com", password: "incorrect-password" });
  assert.equal(response.status, 401);
  assert.equal(response.body.error.code, "INVALID_CREDENTIALS");
});
