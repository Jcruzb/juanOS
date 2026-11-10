import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
const source = fs.readFileSync(new URL("../../../scripts/juanos-host-action", import.meta.url), "utf8");
const start = source.indexOf("function nginxLocations(app)");
const end = source.indexOf("function writeNginxConfig(app)");
const render = new Function("safePort", "fail", source.slice(start, end) + "; return nginxLocations;")(
  value => { assert.ok(Number.isInteger(value) && value > 0 && value < 65536); return value; },
  message => { throw new Error(message); }
);
test("root policy adds a bounded exact route and retains the normal proxy", () => {
  const result = render({nginx:{kind:"proxy",webPort:8743,exactRoutes:[{
    path:"/datos",upstreamPort:8766,maxBodyMiB:128,readTimeoutSeconds:120
  }]}});
  assert.match(result,/location = \/datos/);
  assert.match(result,/127\.0\.0\.1:8766/);
  assert.match(result,/client_max_body_size 128m/);
  assert.match(result,/Authorization \$http_authorization/);
  assert.match(result,/location \/ \{/);
  assert.match(result,/127\.0\.0\.1:8743/);
});
test("rejects injected paths and out-of-range bounds", () => {
  for (const route of [
    {path:"/datos; include /etc/passwd",upstreamPort:8766},
    {path:"/datos",upstreamPort:8766,maxBodyMiB:129},
    {path:"/datos",upstreamPort:8766,readTimeoutSeconds:301}
  ]) assert.throws(()=>render({nginx:{kind:"proxy",webPort:8743,exactRoutes:[route]}}));
});
