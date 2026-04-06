import { Hono } from "hono";
import { success } from "../../utils/response";
import institutions from "../../data/institutions.json";

const institutionsRoute = new Hono();

institutionsRoute.get("/", (c) => {
  const origin = new URL(c.req.url).origin;
  const institutionsWithDynamicLogos = institutions.map((inst) => ({
    ...inst,
    logoUri: inst.logoUri ? `${origin}${inst.logoUri}` : null,
  }));
  return success(c, { institutions: institutionsWithDynamicLogos });
});

export { institutionsRoute };
