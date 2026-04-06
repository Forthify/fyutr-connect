import { Hono } from "hono";
import { z } from "zod";
import { UpsiScraper } from "./scraper";
import { success, fail } from "../../utils/response";

const upsiRoute = new Hono();

const loginSchema = z.object({
  studentId: z.string().min(1),
  password: z.string().min(1),
});

upsiRoute.post("/", async (c) => {
  try {
    const body = await c.req.json();
    const result = loginSchema.safeParse(body);

    if (!result.success) {
      return fail(c, "VALIDATION_ERROR", "Invalid input", 400);
    }

    const { studentId, password } = result.data;
    const scraper = new UpsiScraper();

    try {
      const calendars = await scraper.scrape(studentId, password);
      return success(c, { calendars });
    } catch (error: any) {
      if (error.message.includes("Login failed")) {
        return fail(c, "INVALID_CREDENTIALS", error.message, 401);
      }
      return fail(c, "INTERNAL_SERVER_ERROR", error.message, 500);
    }
  } catch {
    return fail(c, "BAD_REQUEST", "Invalid JSON body", 400);
  }
});

export { upsiRoute };
