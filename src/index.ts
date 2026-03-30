import { Hono } from "hono";
import { iiumRoute } from "./institution/iium/route";
import { iicRoute } from "./institution/iic/route";
import { uitmRoute } from "./institution/uitm/route";
import { contributorsRoute } from "./routes/contributors/route";

const app = new Hono();

app.route("/institution/iium", iiumRoute);
app.route("/institution/iic", iicRoute);
app.route("/institution/uitm", uitmRoute);
app.route("/contributors", contributorsRoute);

app.get("/", (c) => {
  return c.text("Hello Hono!");
});

export default app;
