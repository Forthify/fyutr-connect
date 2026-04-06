import { Hono } from "hono";
import { iiumRoute } from "./institution/iium/route";
import { iicRoute } from "./institution/iic/route";
import { uitmRoute } from "./institution/uitm/route";
import { contributorsRoute } from "./routes/contributors/route";
import { institutionsRoute } from "./routes/institutions/route";
import { apuRoute } from "./institution/apu/route";
import { uniklRoute } from "./institution/unikl/route";
import { utmRoute } from "./institution/utm/route";

const app = new Hono();

app.route("/institution/iium", iiumRoute);
app.route("/institution/iic", iicRoute);
app.route("/institution/uitm", uitmRoute);
app.route("/institution/apu", apuRoute);
app.route("/institution/unikl", uniklRoute);
app.route("/institution/utm", utmRoute);
app.route("/contributors", contributorsRoute);
app.route("/institutions", institutionsRoute);

app.get("/", (c) => {
  return c.text("Hello Hono!");
});

export default app;
