import { Hono } from "hono";
import { iiumRoute } from "./institution/iium/route";
import { iicRoute } from "./institution/iic/route";

const app = new Hono();

app.route("/institution/iium", iiumRoute);
app.route("/institution/iic", iicRoute);

app.get("/", (c) => {
  return c.text("Hello Hono!");
});

export default app;
