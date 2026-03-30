import { Hono } from "hono";
import { success } from "../../utils/response";
import contributors from "../../data/contributors.json";

const contributorsRoute = new Hono();

contributorsRoute.get("/", (c) => {
  return success(c, { institutions: contributors });
});

export { contributorsRoute };
