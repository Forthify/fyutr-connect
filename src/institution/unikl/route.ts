import { Hono } from "hono";
import { z } from "zod";
import { UniKLScraper } from "./scraper";
import { success, fail } from "../../utils/response";

const uniklRoute = new Hono();

const loginSchema = z.object({
  studentId: z.string().min(1, "Student ID is required"),
  password: z.string().min(1, "Password is required"),
});

uniklRoute.post("/", async (c) => {
  try {
    const body = await c.req.json();
    const result = loginSchema.safeParse(body);

    if (!result.success) {
      return fail(c, "VALIDATION_ERROR", "Invalid input", 400, result.error.format());
    }

    const { studentId, password } = result.data;
    const scraper = new UniKLScraper();

    try {
      const calendars = await scraper.scrape(studentId, password);
      return success(c, { calendars });
    } catch (error: any) {
      if (error?.message?.includes("Login failed")) {
        return fail(c, "INVALID_CREDENTIALS", error.message, 401);
      }
      return fail(c, "INTERNAL_SERVER_ERROR", error.message || "Unknown error occurred", 500);
    }
  } catch (error: any) {
    return fail(c, "BAD_REQUEST", "Invalid JSON body", 400);
  }
});

export { uniklRoute };
