import { Hono } from "hono";
import { iiumRoute } from "./institution/iium/route";

const app = new Hono();

app.route("/institution/iium", iiumRoute);

app.get("/", (c) => {
  return c.text("Hello Hono!");
});

export default app;
